--------------------------- MODULE ProviderSettings ---------------------------
(***************************************************************************)
(* Provider connection, model family, and default-settings state machine. *)
(*                                                                         *)
(* Source of truth (every action cites the code it abstracts):            *)
(*   PDS = desktop/main/providers/provider-definition-service.mjs          *)
(*   IPC = desktop/main/ipc/register-ipc.mjs                               *)
(*   UI  = desktop/renderer/src/provider-ui.js, provider-ui-model.js       *)
(*   RTB = desktop/main/services/graphcomplete-runtime.mjs (lease broker)  *)
(*   CAT = crates/relayer-app-server/src/storage/sqlite/catalog.rs         *)
(*                                                                         *)
(* Scope. One existing managed-login provider "P" (reconnect, logout,     *)
(* remove, execution leases, catalog refresh) and one new managed-login   *)
(* connection "N" (connect, complete, cancel). One renderer owns both     *)
(* attempts. Families: the user's "custom" family and P's policy-managed  *)
(* system family "managedP".                                              *)
(*                                                                         *)
(* The JS provider queue (PDS #serialized) is a lock. A serialized         *)
(* operation with no interior await that an unserialized actor can         *)
(* observe is one atomic step. Operations whose interior awaits race an    *)
(* unserialized actor (preparing-cancel, close, the renderer) are split at *)
(* those awaits. An operation is requested when it takes the free lock,   *)
(* and a queued cancel runs before any later request (FIFO). Requests     *)
(* that queue behind an await may still start in either order.           *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS MaxTransientChecks,  \* PDS MAX_TRANSIENT_ACCOUNT_CHECKS (3)
          Execs,               \* concurrent turns that lease provider P
          RuntimeIds           \* runtime objects that may be created

Ids == {"P", "N"}
Families == {"custom", "managedP"}
NoRt == 0

VARIABLES
  \* --- desktop main, provider service (PDS:89-99) ---
  lock,        \* holder of the #serialized queue, or "none"
  defs,        \* id -> absent | active | removal_pending | tombstoned
  rmap,        \* id -> runtime in this.runtimes, or NoRt
  rt,          \* runtime -> unused | open | closed
  pend,        \* id -> [kind |-> none|connect|reconnect, rt, fails]
  prep,        \* N's preparingConnections entry: none | cancellable
  cancelled,   \* N's preparation.cancelled
  override,    \* P's statusOverrides entry: none | logged_out | login_pending
  closing,     \* close() started
  closed,      \* close() finished clearing the maps
  \* --- per-actor program counters ---
  connPc,      \* N's connect: IPC handler + #connect
  connRt,      \* runtime #connect created for N
  reconPc,     \* P's reconnect: IPC handler + #reconnect
  reconRt,
  reconCreated,
  complPc,     \* id -> idle | await (completeConnection holding the lock)
  complCap,    \* id -> the pending entry completeConnection captured
  exec,        \* e -> [pc |-> idle|admitted|creating|holding|done, rt]
  \* --- IPC ownership (IPC:105-131) ---
  alive,       \* the renderer that began both attempts
  bound,       \* id -> a "destroyed" listener is registered
  cancelQ,     \* id -> a serialized cancelConnection is queued
  ipcDone,     \* id -> the connect/reconnect IPC handler returned
  \* --- app-server SQLite (CAT) ---
  sqlConnected, \* model_providers.connected for P
  fam,          \* family -> [state |-> active|tombstoned, enabled]
  defaultFamily

vars == <<lock, defs, rmap, rt, pend, prep, cancelled, override, closing,
          closed, connPc, connRt, reconPc, reconRt, reconCreated, complPc,
          complCap, exec, alive, bound, cancelQ, ipcDone, sqlConnected, fam,
          defaultFamily>>

NoPend == [kind |-> "none", rt |-> NoRt, fails |-> 0]
Holders == {e \in Execs : exec[e].pc = "holding"}
FreeRts == {r \in RuntimeIds : rt[r] = "unused"}
\* Runtimes are numbered in creation order, as the trace adapters number them.
NextRt == CHOOSE r \in FreeRts : \A s \in FreeRts : r <= s
\* An operation starting now was requested now, so a cancel already queued
\* runs first (FIFO). Only RunCancel may take the queue while one waits.
Free == lock = "none" /\ \A i \in Ids : ~cancelQ[i]

\* What list() reports (PDS:121-141): an override wins over SQLite.
ShownConnected == override = "none" /\ sqlConnected

Init ==
  /\ lock = "none"
  /\ defs = [i \in Ids |-> IF i = "P" THEN "active" ELSE "absent"]
  /\ rmap = [i \in Ids |-> IF i = "P" THEN 1 ELSE NoRt]
  /\ rt = [r \in RuntimeIds |-> IF r = 1 THEN "open" ELSE "unused"]
  /\ pend = [i \in Ids |-> NoPend]
  /\ prep = "none"
  /\ cancelled = FALSE
  /\ override = "none"
  /\ closing = FALSE
  /\ closed = FALSE
  /\ connPc = "idle"
  /\ connRt = NoRt
  /\ reconPc = "idle"
  /\ reconRt = NoRt
  /\ reconCreated = FALSE
  /\ complPc = [i \in Ids |-> "idle"]
  /\ complCap = [i \in Ids |-> NoPend]
  /\ exec = [e \in Execs |-> [pc |-> "idle", rt |-> NoRt]]
  /\ alive = TRUE
  /\ bound = [i \in Ids |-> FALSE]
  /\ cancelQ = [i \in Ids |-> FALSE]
  /\ ipcDone = [i \in Ids |-> FALSE]
  /\ sqlConnected = TRUE
  /\ fam = [f \in Families |-> [state |-> "active", enabled |-> TRUE]]
  /\ defaultFamily \in Families

-----------------------------------------------------------------------------
(* #cancelPendingConnection (PDS:462-496) for every id in S. Both branches *)
(* delete the runtime from this.runtimes and close it; neither consults    *)
(* leases. The reconnect branch marks the provider signed out.             *)
CancelSetEffect(S) ==
  LET live == {i \in S : pend[i].kind /= "none"}
  IN /\ pend' = [i \in Ids |-> IF i \in live THEN NoPend ELSE pend[i]]
     /\ rmap' = [i \in Ids |-> IF i \in live THEN NoRt ELSE rmap[i]]
     /\ rt' = [r \in RuntimeIds |->
                IF \E i \in live : pend[i].rt = r THEN "closed" ELSE rt[r]]
     /\ override' = IF "P" \in live /\ pend["P"].kind = "reconnect"
                    THEN "logged_out" ELSE override

CancelPendingEffect(id) == CancelSetEffect({id})

(* cancelConnection (PDS:452-460) for every id in S, from the cancel IPC,  *)
(* a failed browser handoff, or the renderer's "destroyed" listeners. A    *)
(* preparing attempt is only flagged. Anything else takes the queue: at    *)
(* once when it is free, otherwise behind the operation holding it.        *)
RequestCancels(S) ==
  LET prepHit == "N" \in S /\ prep /= "none"
      queued == IF prepHit THEN S \ {"N"} ELSE S
  IN /\ cancelled' = (cancelled \/ (prepHit /\ prep = "cancellable"))
     /\ IF lock = "none" /\ \A i \in Ids : ~cancelQ[i]
        THEN /\ CancelSetEffect(queued)
             /\ UNCHANGED cancelQ
        ELSE /\ cancelQ' = [i \in Ids |-> cancelQ[i] \/ i \in queued]
             /\ UNCHANGED <<pend, rmap, rt, override>>

RequestCancel(id) == RequestCancels({id})

-----------------------------------------------------------------------------
(* New connection N: relayer:provider-connect (IPC:162-172) -> #connect   *)
(* (PDS:196-318), managed-login branch.                                   *)
ConnStart ==
  /\ connPc = "idle" /\ alive /\ ~closing
  /\ prep' = "cancellable"
  /\ connPc' = "s1"
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, cancelled, override, closing,
                 closed, connRt, reconPc, reconRt, reconCreated, complPc,
                 complCap, exec, alive, bound, cancelQ, ipcDone, sqlConnected,
                 fam, defaultFamily>>

\* S1 (PDS:225-234) is atomic; prepareRuntime then runs outside the queue.
ConnS1 ==
  /\ connPc = "s1" /\ Free
  /\ IF cancelled \/ pend["N"].kind /= "none" \/ defs["N"] /= "absent"
     THEN connPc' = "fail"
     ELSE connPc' = "s2"
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, prep, cancelled, override,
                 closing, closed, connRt, reconPc, reconRt, reconCreated,
                 complPc, complCap, exec, alive, bound, cancelQ, ipcDone,
                 sqlConnected, fam, defaultFamily>>

\* S2 (PDS:242-258): re-check, create the runtime, then await login()
\* while holding the queue.
ConnS2 ==
  /\ connPc = "s2" /\ Free
  /\ IF cancelled \/ FreeRts = {}
     THEN /\ connPc' = "fail"
          /\ UNCHANGED <<lock, rt, connRt>>
     ELSE /\ lock' = "connN"
          /\ rt' = [rt EXCEPT ![NextRt] = "open"]
          /\ connRt' = NextRt
          /\ connPc' = "login"
  /\ UNCHANGED <<defs, rmap, pend, prep, cancelled, override, closing, closed,
                 reconPc, reconRt, reconCreated, complPc, complCap, exec,
                 alive, bound, cancelQ, ipcDone, sqlConnected, fam,
                 defaultFamily>>

\* login() resolves; cancellation observed at PDS:257; pending set at :258.
\* The finally block deletes the preparation (PDS:316).
ConnLogin ==
  /\ connPc = "login"
  /\ lock' = "none"
  /\ prep' = "none"
  /\ IF cancelled
     THEN /\ rt' = [rt EXCEPT ![connRt] = "closed"]  \* catch: runtime.close()
          /\ connPc' = "ipcdone"
          /\ UNCHANGED pend
     ELSE /\ pend' = [pend EXCEPT !["N"] =
                        [kind |-> "connect", rt |-> connRt, fails |-> 0]]
          /\ connPc' = "handoff"
          /\ UNCHANGED rt
  /\ UNCHANGED <<defs, rmap, cancelled, override, closing, closed, connRt,
                 reconPc, reconRt, reconCreated, complPc, complCap, exec,
                 alive, bound, cancelQ, ipcDone, sqlConnected, fam,
                 defaultFamily>>

ConnFail ==
  /\ connPc = "fail"
  /\ prep' = "none"
  /\ connPc' = "ipcdone"
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, cancelled, override, closing,
                 closed, connRt, reconPc, reconRt, reconCreated, complPc,
                 complCap, exec, alive, bound, cancelQ, ipcDone, sqlConnected,
                 fam, defaultFamily>>

-----------------------------------------------------------------------------
(* Existing provider P: relayer:provider-reconnect (IPC:223-233) ->        *)
(* #reconnect (PDS:552-606). The UI offers Reconnect only while list()     *)
(* reports the provider disconnected (UI provider-ui.js:187).              *)
ReconGuard == defs["P"] = "active" /\ Holders = {} /\ pend["P"].kind = "none"

ReconStart ==
  /\ reconPc = "idle" /\ alive /\ ~closing /\ Free
  /\ ~ShownConnected /\ defs["P"] = "active"
  /\ reconPc' = IF ReconGuard THEN "prep" ELSE "ipcdone"
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, prep, cancelled, override,
                 closing, closed, connPc, connRt, reconRt, reconCreated,
                 complPc, complCap, exec, alive, bound, cancelQ, ipcDone,
                 sqlConnected, fam, defaultFamily>>

\* prepareRuntime ran outside the queue; the second serialized block
\* re-checks the guard, reuses or creates the runtime, and awaits login().
ReconS2 ==
  /\ reconPc = "prep" /\ Free
  /\ IF closing \/ ~ReconGuard \/ (rmap["P"] = NoRt /\ FreeRts = {})
     THEN /\ reconPc' = "ipcdone"
          /\ UNCHANGED <<lock, rt, reconRt, reconCreated>>
     ELSE /\ lock' = "reconP"
          /\ reconPc' = "login"
          /\ IF rmap["P"] /= NoRt
             THEN /\ reconRt' = rmap["P"]
                  /\ reconCreated' = FALSE
                  /\ UNCHANGED rt
             ELSE /\ rt' = [rt EXCEPT ![NextRt] = "open"]
                  /\ reconRt' = NextRt
                  /\ reconCreated' = TRUE
  /\ UNCHANGED <<defs, rmap, pend, prep, cancelled, override, closing, closed,
                 connPc, connRt, complPc, complCap, exec, alive, bound,
                 cancelQ, ipcDone, sqlConnected, fam, defaultFamily>>

ReconLogin(ok) ==
  /\ reconPc = "login"
  /\ lock' = "none"
  /\ \/ /\ ~ok \/ closing   \* login() rejected, or closing observed (PDS:583)
        /\ reconPc' = "ipcdone"
        /\ rt' = IF reconCreated THEN [rt EXCEPT ![reconRt] = "closed"] ELSE rt
        /\ UNCHANGED <<rmap, pend, override>>
     \/ /\ ok /\ ~closing
        /\ rmap' = [rmap EXCEPT !["P"] = reconRt]
        /\ pend' = [pend EXCEPT !["P"] =
                      [kind |-> "reconnect", rt |-> reconRt, fails |-> 0]]
        /\ override' = "login_pending"
        /\ reconPc' = "handoff"
        /\ UNCHANGED rt
  /\ UNCHANGED <<defs, prep, cancelled, closing, closed, connPc, connRt,
                 reconRt, reconCreated, complPc, complCap, exec, alive, bound,
                 cancelQ, ipcDone, sqlConnected, fam, defaultFamily>>

-----------------------------------------------------------------------------
(* Browser handoff and binding, shared by both IPC handlers (IPC:12-39,   *)
(* 121-137). A failed handoff awaits cancelConnection and binds nothing, *)
(* and contents already destroyed cancel the attempt instead of binding. *)
PcOf(id) == IF id = "N" THEN connPc ELSE reconPc
SetPc(id, v) ==
  IF id = "N" THEN /\ connPc' = v /\ UNCHANGED reconPc
              ELSE /\ reconPc' = v /\ UNCHANGED connPc

\* handOffToBrowser resolves and bindConnection runs in the same
\* continuation, so nothing can interleave between them. Contents already
\* destroyed are not bound; the attempt is cancelled instead (IPC:121-137).
Handoff(id, ok) ==
  /\ PcOf(id) = "handoff"
  /\ SetPc(id, "ipcdone")
  /\ IF ok /\ alive
     THEN /\ bound' = [bound EXCEPT ![id] = TRUE]
          /\ UNCHANGED <<cancelQ, cancelled, pend, rmap, rt, override>>
     ELSE /\ RequestCancel(id)
          /\ UNCHANGED bound
  /\ UNCHANGED <<lock, defs, prep, closing, closed, connRt, reconRt,
                 reconCreated, complPc, complCap, exec, alive, ipcDone,
                 sqlConnected, fam, defaultFamily>>

IpcReturn(id) ==
  /\ PcOf(id) = "ipcdone"
  /\ ipcDone' = [ipcDone EXCEPT ![id] = TRUE]
  /\ SetPc(id, "done")
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, prep, cancelled, override,
                 closing, closed, connRt, reconRt, reconCreated, complPc,
                 complCap, exec, alive, bound, cancelQ, sqlConnected, fam,
                 defaultFamily>>

(* relayer:provider-connect-cancel (IPC:206-210): release, then cancel.   *)
RendererCancel(id) ==
  /\ alive
  /\ bound' = [bound EXCEPT ![id] = FALSE]
  /\ RequestCancel(id)
  /\ UNCHANGED <<lock, defs, prep, closing, closed, connPc, connRt, reconPc,
                 reconRt, reconCreated, complPc, complCap, exec, alive,
                 ipcDone, sqlConnected, fam, defaultFamily>>

(* The renderer is destroyed; each bound listener fires once (IPC:31-39). *)
RendererDestroyed ==
  /\ alive
  /\ alive' = FALSE
  /\ bound' = [i \in Ids |-> FALSE]
  /\ RequestCancels({i \in Ids : bound[i]})
  /\ UNCHANGED <<lock, defs, prep, closing, closed, connPc, connRt, reconPc,
                 reconRt, reconCreated, complPc, complCap, exec, ipcDone,
                 sqlConnected, fam, defaultFamily>>

RunCancel(id) ==
  /\ cancelQ[id] /\ lock = "none"
  /\ cancelQ' = [cancelQ EXCEPT ![id] = FALSE]
  /\ CancelPendingEffect(id)
  /\ UNCHANGED <<lock, defs, prep, cancelled, closing, closed, connPc, connRt,
                 reconPc, reconRt, reconCreated, complPc, complCap, exec,
                 alive, bound, ipcDone, sqlConnected, fam, defaultFamily>>

-----------------------------------------------------------------------------
(* completeConnection (PDS:328-442), the renderer's 750 ms poll. It holds *)
(* the queue across account(), discovery, and the durable commit, and it  *)
(* is not a lifecycle task, so close() does not wait for it. The pending  *)
(* entry it captured is what it registers, even if close() cleared the    *)
(* maps under its awaits.                                                  *)
CompleteStart(id) ==
  /\ complPc[id] = "idle" /\ Free
  /\ alive /\ ipcDone[id] /\ pend[id].kind /= "none"
  /\ lock' = IF id = "P" THEN "complP" ELSE "complN"
  /\ complPc' = [complPc EXCEPT ![id] = "await"]
  /\ complCap' = [complCap EXCEPT ![id] = pend[id]]
  /\ UNCHANGED <<defs, rmap, rt, pend, prep, cancelled, override, closing,
                 closed, connPc, connRt, reconPc, reconRt, reconCreated, exec,
                 alive, bound, cancelQ, ipcDone, sqlConnected, fam,
                 defaultFamily>>

CompleteFinish(id, outcome) ==
  LET p == complCap[id]
      isRecon == p.kind = "reconnect"
      budgetLeft == ~isRecon /\ p.fails + 1 < MaxTransientChecks
      live == pend[id].kind /= "none"
  IN
  /\ complPc[id] = "await"
  /\ lock' = "none"
  /\ complPc' = [complPc EXCEPT ![id] = "idle"]
  /\ complCap' = [complCap EXCEPT ![id] = NoPend]
  /\ CASE outcome = "connected" ->
            /\ pend' = [pend EXCEPT ![id] = NoPend]
            /\ rmap' = [rmap EXCEPT ![id] = p.rt]
            /\ IF isRecon
               THEN /\ sqlConnected' = TRUE          \* publishCatalog
                    /\ override' = "none"
                    /\ UNCHANGED <<defs, rt, fam>>
               ELSE /\ defs' = [defs EXCEPT ![id] = "active"] \* createWithCatalog
                    /\ UNCHANGED <<rt, sqlConnected, fam, override>>
       [] outcome = "disconnected" ->
            /\ pend' = IF live THEN [pend EXCEPT ![id].fails = 0] ELSE pend
            /\ UNCHANGED <<rmap, rt, defs, sqlConnected, fam, override>>
       [] outcome = "check_failed" /\ budgetLeft ->
            /\ pend' = IF live THEN [pend EXCEPT ![id].fails = p.fails + 1] ELSE pend
            /\ UNCHANGED <<rmap, rt, defs, sqlConnected, fam, override>>
       [] OTHER ->  \* settle(): terminal failure cancels the pending attempt
            /\ CancelPendingEffect(id)
            /\ UNCHANGED <<defs, sqlConnected, fam>>
  \* The IPC handler releases the renderer binding once the attempt is no
  \* longer pending (IPC:185-194).
  /\ bound' = IF outcome = "disconnected" \/ (outcome = "check_failed" /\ budgetLeft)
             THEN bound ELSE [bound EXCEPT ![id] = FALSE]
  /\ UNCHANGED <<prep, cancelled, closing, closed, connPc, connRt, reconPc,
                 reconRt, reconCreated, exec, alive, cancelQ, ipcDone,
                 defaultFamily>>

-----------------------------------------------------------------------------
(* A turn on provider P. Rust admission resolves the plan against SQLite  *)
(* (CAT:1632-1710: provider connected and active), and only later does    *)
(* the harness call the lease broker (RTB:181-227) -> acquireExecution    *)
(* (PDS:608-634), which checks only that the definition is active and     *)
(* does not look at closing. #runtimeFor awaits onRuntimeReady before     *)
(* registering a new runtime (PDS:638-656).                               *)
ExecAdmit(e) ==
  /\ exec[e].pc = "idle"
  /\ defs["P"] = "active" /\ sqlConnected
  /\ exec' = [exec EXCEPT ![e].pc = "admitted"]
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, prep, cancelled, override,
                 closing, closed, connPc, connRt, reconPc, reconRt,
                 reconCreated, complPc, complCap, alive, bound, cancelQ,
                 ipcDone, sqlConnected, fam, defaultFamily>>

ExecAcquire(e) ==
  /\ exec[e].pc = "admitted" /\ Free
  /\ IF defs["P"] /= "active"
     THEN /\ exec' = [exec EXCEPT ![e] = [pc |-> "done", rt |-> NoRt]]
          /\ UNCHANGED <<lock, rt>>
     ELSE IF rmap["P"] /= NoRt
     THEN /\ exec' = [exec EXCEPT ![e] = [pc |-> "holding", rt |-> rmap["P"]]]
          /\ UNCHANGED <<lock, rt>>
     ELSE IF FreeRts = {}
     THEN /\ exec' = [exec EXCEPT ![e] = [pc |-> "done", rt |-> NoRt]]
          /\ UNCHANGED <<lock, rt>>
     ELSE /\ lock' = "exec"
          /\ rt' = [rt EXCEPT ![NextRt] = "open"]
          /\ exec' = [exec EXCEPT ![e] = [pc |-> "creating", rt |-> NextRt]]
  /\ UNCHANGED <<defs, rmap, pend, prep, cancelled, override, closing, closed,
                 connPc, connRt, reconPc, reconRt, reconCreated, complPc,
                 complCap, alive, bound, cancelQ, ipcDone, sqlConnected, fam,
                 defaultFamily>>

ExecRegistered(e) ==
  /\ exec[e].pc = "creating"
  /\ lock' = "none"
  /\ rmap' = [rmap EXCEPT !["P"] = exec[e].rt]
  /\ override' = "none"
  /\ exec' = [exec EXCEPT ![e].pc = "holding"]
  /\ UNCHANGED <<defs, rt, pend, prep, cancelled, closing, closed, connPc,
                 connRt, reconPc, reconRt, reconCreated, complPc, complCap,
                 alive, bound, cancelQ, ipcDone, sqlConnected, fam,
                 defaultFamily>>

(* #finalizeRemoval (PDS:744-761): tombstone commits, then the runtime in *)
(* this.runtimes is closed.                                               *)
FinalizeRemoval ==
  /\ defs' = [defs EXCEPT !["P"] = "tombstoned"]
  /\ rt' = IF rmap["P"] /= NoRt THEN [rt EXCEPT ![rmap["P"]] = "closed"] ELSE rt
  /\ rmap' = [rmap EXCEPT !["P"] = NoRt]

ExecRelease(e) ==
  /\ exec[e].pc = "holding" /\ Free
  /\ exec' = [exec EXCEPT ![e] = [pc |-> "done", rt |-> NoRt]]
  /\ IF Holders = {e} /\ defs["P"] = "removal_pending"
     THEN FinalizeRemoval
     ELSE UNCHANGED <<defs, rt, rmap>>
  /\ UNCHANGED <<lock, pend, prep, cancelled, override, closing, closed,
                 connPc, connRt, reconPc, reconRt, reconCreated, complPc,
                 complCap, alive, bound, cancelQ, ipcDone, sqlConnected, fam,
                 defaultFamily>>

-----------------------------------------------------------------------------
(* logout (PDS:513-545). A failed catalog refresh is only logged, so      *)
(* model_providers.connected may keep its old value.                      *)
\* refreshed: the catalog refresh after logout published (connected = 0).
Logout(refreshed) ==
  /\ Free /\ defs["P"] = "active" /\ Holders = {} /\ rmap["P"] /= NoRt
  /\ sqlConnected' = (sqlConnected /\ ~refreshed)
  /\ override' = "logged_out"
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, prep, cancelled, closing, closed,
                 connPc, connRt, reconPc, reconRt, reconCreated, complPc,
                 complCap, exec, alive, bound, cancelQ, ipcDone, fam,
                 defaultFamily>>

(* remove (PDS:721-737) with the SQLite guard_provider_removal            *)
(* (CAT:2509-2559) and tombstone_managed_provider_families (CAT:186).     *)
(* P is never the default provider in this model, so the guard reduces to *)
(* "the default family keeps a member outside P", i.e. is not managedP.  *)
(* The UI offers Remove for any non-default provider (provider-ui.js:210).*)
(* removal_pending "immediately blocks new attempts" (architecture.md), so *)
(* a pending reconnect is dropped; its runtime is the one in rmap.         *)
Remove ==
  /\ Free /\ defs["P"] = "active"
  /\ defaultFamily /= "managedP"
  /\ pend' = [pend EXCEPT !["P"] = NoPend]
  /\ fam' = [fam EXCEPT !["managedP"] = [state |-> "tombstoned", enabled |-> FALSE]]
  /\ IF Holders = {}
     THEN FinalizeRemoval
     ELSE /\ defs' = [defs EXCEPT !["P"] = "removal_pending"]
          /\ UNCHANGED <<rt, rmap>>
  /\ UNCHANGED <<lock, prep, cancelled, override, closing, closed,
                 connPc, connRt, reconPc, reconRt, reconCreated, complPc,
                 complCap, exec, alive, bound, cancelQ, ipcDone, sqlConnected,
                 defaultFamily>>

-----------------------------------------------------------------------------
(* Model settings in SQLite. Catalog refresh runs on the model catalog    *)
(* service's own queue, not the provider queue, through whichever runtime *)
(* is registered, including one reused by a pending reconnect.            *)

\* publish_provider_catalog (CAT:681-765). "no_eligible" is the
\* provider_no_eligible_execution_models reason, which tombstones P's
\* managed families without consulting product_model_preferences. A later
\* publish with eligible models reactivates the same family id
\* (replace_system_family, CAT:2310-2333).
CatalogRefresh(outcome) ==
  /\ defs["P"] = "active" /\ ~closed
  /\ sqlConnected' = (outcome = "models")
  /\ fam' = CASE outcome = "models" ->
                   [fam EXCEPT !["managedP"] = [state |-> "active", enabled |-> TRUE]]
              [] outcome = "no_eligible" ->
                   [fam EXCEPT !["managedP"] = [state |-> "tombstoned", enabled |-> FALSE]]
              [] OTHER -> fam
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, prep, cancelled, override,
                 closing, closed, connPc, connRt, reconPc, reconRt,
                 reconCreated, complPc, complCap, exec, alive, bound, cancelQ,
                 ipcDone, defaultFamily>>

\* update_model_settings_defaults (CAT:583-679): the family must resolve.
SetDefaultFamily(f) ==
  /\ fam[f].state = "active" /\ fam[f].enabled
  /\ f = "managedP" => (sqlConnected /\ defs["P"] = "active")
  /\ defaultFamily' = f
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, prep, cancelled, override,
                 closing, closed, connPc, connRt, reconPc, reconRt,
                 reconCreated, complPc, complCap, exec, alive, bound, cancelQ,
                 ipcDone, sqlConnected, fam>>

\* update_model_family / delete_model_family (CAT:801-860): both refuse the
\* default family; system families are read-only.
DisableOrDeleteCustom(state) ==
  /\ defaultFamily /= "custom" /\ fam["custom"].state = "active"
  /\ fam' = [fam EXCEPT !["custom"] = [state |-> state, enabled |-> FALSE]]
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, prep, cancelled, override,
                 closing, closed, connPc, connRt, reconPc, reconRt,
                 reconCreated, complPc, complCap, exec, alive, bound, cancelQ,
                 ipcDone, sqlConnected, defaultFamily>>

EnableCustom ==
  /\ fam["custom"].state = "active" /\ ~fam["custom"].enabled
  /\ fam' = [fam EXCEPT !["custom"].enabled = TRUE]
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, prep, cancelled, override,
                 closing, closed, connPc, connRt, reconPc, reconRt,
                 reconCreated, complPc, complCap, exec, alive, bound, cancelQ,
                 ipcDone, sqlConnected, defaultFamily>>

-----------------------------------------------------------------------------
(* close() (PDS:778-795). It flags cancellable preparations, awaits the   *)
(* lifecycle tasks (connect and reconnect promises only; not the queue),  *)
(* then closes and clears every runtime in this.runtimes and              *)
(* pendingConnections.                                                    *)
ServicePc(pc) == pc \in {"s1", "s2", "login", "prep", "fail"}

CloseStart ==
  /\ ~closing
  /\ closing' = TRUE
  /\ cancelled' = (cancelled \/ prep = "cancellable")
  /\ UNCHANGED <<lock, defs, rmap, rt, pend, prep, override, closed, connPc,
                 connRt, reconPc, reconRt, reconCreated, complPc, complCap,
                 exec, alive, bound, cancelQ, ipcDone, sqlConnected, fam,
                 defaultFamily>>

CloseFinish ==
  /\ closing /\ ~closed
  /\ ~ServicePc(connPc) /\ ~ServicePc(reconPc)
  /\ LET owned == {rmap[i] : i \in Ids} \cup {pend[i].rt : i \in Ids}
     IN rt' = [r \in RuntimeIds |-> IF r \in owned THEN "closed" ELSE rt[r]]
  /\ rmap' = [i \in Ids |-> NoRt]
  /\ pend' = [i \in Ids |-> NoPend]
  /\ prep' = "none"
  /\ closed' = TRUE
  /\ UNCHANGED <<lock, defs, cancelled, override, closing, connPc, connRt,
                 reconPc, reconRt, reconCreated, complPc, complCap, exec,
                 alive, bound, cancelQ, ipcDone, sqlConnected, fam,
                 defaultFamily>>

-----------------------------------------------------------------------------
Next ==
  \/ ConnStart \/ ConnS1 \/ ConnS2 \/ ConnLogin \/ ConnFail
  \/ ReconStart \/ ReconS2 \/ \E ok \in BOOLEAN : ReconLogin(ok)
  \/ \E id \in Ids : \/ \E ok \in BOOLEAN : Handoff(id, ok)
                     \/ IpcReturn(id) \/ RendererCancel(id) \/ RunCancel(id)
                     \/ CompleteStart(id)
                     \/ \E o \in {"connected", "disconnected", "check_failed",
                                  "catalog_failed"} : CompleteFinish(id, o)
  \/ RendererDestroyed
  \/ \E e \in Execs : ExecAdmit(e) \/ ExecAcquire(e) \/ ExecRegistered(e)
                      \/ ExecRelease(e)
  \/ \E refreshed \in BOOLEAN : Logout(refreshed)
  \/ Remove
  \/ \E o \in {"models", "no_eligible", "disconnected"} : CatalogRefresh(o)
  \/ \E f \in Families : SetDefaultFamily(f)
  \/ \E st \in {"active", "tombstoned"} : DisableOrDeleteCustom(st)
  \/ EnableCustom
  \/ CloseStart \/ CloseFinish

(* A scenario step is a tuple naming one action and its arguments, as the  *)
(* trace adapters name them (models/tla/scenarios.json).                   *)
Act(s) ==
  LET n == s[1] IN
  CASE n = "ConnStart" -> ConnStart
    [] n = "ConnS1" -> ConnS1
    [] n = "ConnS2" -> ConnS2
    [] n = "ConnLogin" -> ConnLogin
    [] n = "ConnFail" -> ConnFail
    [] n = "ReconStart" -> ReconStart
    [] n = "ReconS2" -> ReconS2
    [] n = "ReconLogin" -> ReconLogin(s[2] = "ok")
    [] n = "Handoff" -> Handoff(s[2], s[3] = "ok")
    [] n = "IpcReturn" -> IpcReturn(s[2])
    [] n = "RendererCancel" -> RendererCancel(s[2])
    [] n = "RunCancel" -> RunCancel(s[2])
    [] n = "RendererDestroyed" -> RendererDestroyed
    [] n = "CompleteStart" -> CompleteStart(s[2])
    [] n = "CompleteFinish" -> CompleteFinish(s[2], s[3])
    [] n = "ExecAdmit" -> ExecAdmit(s[2])
    [] n = "ExecAcquire" -> ExecAcquire(s[2])
    [] n = "ExecRegistered" -> ExecRegistered(s[2])
    [] n = "ExecRelease" -> ExecRelease(s[2])
    [] n = "Logout" -> Logout(s[2] = "refreshed")
    [] n = "Remove" -> Remove
    [] n = "CloseStart" -> CloseStart
    [] n = "CloseFinish" -> CloseFinish

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants. Each names the promise it checks.                          *)

TypeOK ==
  /\ lock \in {"none", "connN", "reconP", "complP", "complN", "exec"}
  /\ defs \in [Ids -> {"absent", "active", "removal_pending", "tombstoned"}]
  /\ rt \in [RuntimeIds -> {"unused", "open", "closed"}]
  /\ override \in {"none", "logged_out", "login_pending"}
  /\ defaultFamily \in Families

\* A runtime a running turn holds is never closed under it. The logout and
\* reconnect guards refuse while leases exist, and #finalizeRemoval waits
\* for the last lease: "the runtime and credentials remain usable by that
\* attempt" (PDS:748-750). Shutdown closing everything is out of scope.
LeasedRuntimeStaysOpen ==
  ~closing =>
    \A e \in Execs : exec[e].pc = "holding" => rt[exec[e].rt] = "open"

\* A pending reconnect belongs to a provider that is still active.
PendingReconnectIsForActiveProvider ==
  pend["P"].kind = "reconnect" => defs["P"] = "active"

\* PRD BRW-005: "A pending attempt is owned in the main process by the
\* renderer that began it." Once the IPC handler returned, a live attempt
\* is either bound to a live renderer or already has a cancel queued.
PendingAttemptIsOwned ==
  \A id \in Ids :
    (pend[id].kind /= "none" /\ ipcDone[id])
      => ((alive /\ bound[id]) \/ cancelQ[id])

\* After close() finishes, no runtime is left open.
CloseLeavesNoOpenRuntime ==
  closed => \A r \in RuntimeIds : rt[r] /= "open"

\* The default family is always a live, enabled family. Disable, delete,
\* and provider removal all refuse to break it (CAT:801-860, 2509-2559).
\* The PRD states no such promise; this checks the guards' shared intent.
DefaultFamilyIsLive ==
  fam[defaultFamily].state = "active" /\ fam[defaultFamily].enabled

=============================================================================
