--------------------------- MODULE CompletionCurrent ---------------------------
(***************************************************************************)
(* The durable completion current of one recursive child and the product  *)
(* execution that launches and settles it.                                *)
(*                                                                         *)
(* Source of truth (every action cites the code it abstracts):            *)
(*   CUR = crates/relayer-graph-core/src/graph/completion/current.rs       *)
(*   RT  = crates/relayer-app-server/src/runtime.rs                        *)
(*   THR = crates/relayer-app-server/src/api/threads.rs                    *)
(*   CEX = crates/relayer-app-server/src/storage/sqlite/completion_executions.rs *)
(*   APP = crates/relayer-app-server/src/app_server.rs                     *)
(*   HH  = packages/harness-host/src/host.ts                               *)
(*                                                                         *)
(* Actors: parent broker retries of complete() (Launchers), the child's   *)
(* own model through its graph token, the harness provider run, the       *)
(* semantic observer, the provider-exit observer, the start-failure       *)
(* cleanup task, the parent's stop, and an application restart.           *)
(*                                                                         *)
(* Graph transitions are single BEGIN IMMEDIATE transactions, so each is  *)
(* one atomic step. terminate_graph_completion (RT:1555-1624) is a GET    *)
(* followed by POSTs, so its read and its commit are separate steps.      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Launchers,        \* concurrent broker complete() calls for the same child
  MaxRev,           \* bound on head_revision
  ValidFailReasons, \* CUR validate_terminal_reason FAILURE_REASONS
  ObserveTimesOut,  \* RT CONTROL_REQUEST_TIMEOUT (5 s) can expire on the
                    \* observe GET that HH answers only when the run ends
  CleanExitIsChecked, \* FALSE today: only an observe Err leads to the
                    \* active-current check (THR:1998); a clean exit does not
  ActivationFailureSettlesGraph, \* FALSE today: a lost or failed
                    \* activation settles only the execution row (THR:1437-1463)
  TerminalReadSettlesCleanup \* FALSE today: cleanup's fail loop treats a
                    \* current another actor terminated as an error (RT:1609)

Keys == {"stop", "exit", "start", "attach", "obs", "restart", "activate"}
Reason == [stop |-> "cancelled_by_user",
           exit |-> "provider_exited_without_return",
           start |-> "provider_start_failed",
           attach |-> "provider_attachment_persist_failed",
           obs |-> "graph_observation_failed",
           restart |-> "application_restart",
           activate |-> "execution"]
Target(k) == IF k = "stop" THEN "stopped" ELSE "failed"
Active == {"submitted", "running"}     \* product statuses a finalize accepts
None == 99                 \* no receipt; outside 0..MaxRev

VARIABLES
  \* --- graph DB: completion_states + current_revisions (receipts) ---
  life,         \* active | succeeded | stopped | failed
  head,         \* head_revision
  why,          \* safe_reason of the terminal revision, or "none"
  receipt,      \* key -> base revision of its committed transition, or None
  auth,         \* the child's graph capability is live (epoch current)
  \* --- product DB ---
  phase,        \* none | reserved | launching | attached | settled
  status,       \* child interaction completion_status
  execWhy,      \* completion_executions.safe_reason, or "none"
  \* --- harness ---
  prov,         \* none | running | exited_ok | exited_err | cancelled
  launches,     \* start_invoked_completion successes
  \* --- in-memory actors ---
  appUp,
  lpc,          \* launcher -> program counter
  semPc,        \* off | watch | done
  exitPc,       \* off | wait | check | discard | done
  cleanPc,      \* off | cancel | fail | finalize | discard | done
  stopPc,       \* idle | post | cancel | done
  stopSeen,     \* [h, l] read by stop's GET current
  stopReport,   \* what stop_completion answered the parent
  restartPc     \* none | reconcile | done | aborted

vars == <<life, head, why, receipt, auth, phase, status, execWhy, prov, launches,
          appUp, lpc, semPc, exitPc, cleanPc, stopPc, stopSeen, stopReport,
          restartPc>>
graphVars == <<life, head, why, receipt>>
actorVars == <<lpc, semPc, exitPc, cleanPc, stopPc, stopSeen, stopReport,
               restartPc>>

Init ==
  /\ life = "active" /\ head = 0 /\ why = "none"
  /\ receipt = [k \in Keys |-> None]
  /\ auth = FALSE
  /\ phase = "none" /\ status = "submitted" /\ execWhy = "none"
  /\ prov = "none" /\ launches = 0
  /\ appUp = TRUE
  /\ lpc = [l \in Launchers |-> "idle"]
  /\ semPc = "off" /\ exitPc = "off" /\ cleanPc = "off"
  /\ stopPc = "idle" /\ stopSeen = [h |-> 0, l |-> "active"]
  /\ stopReport = "none"
  /\ restartPc = "none"

-----------------------------------------------------------------------------
(* Trusted-control termination (RT:1555-1624, CUR:21-233).                *)
(* Given what the GET read (h, l): a terminal read replays this key's     *)
(* receipt at h-1 or errors; an active read POSTs at expected=h, which    *)
(* commits only if the reason is valid and nothing moved the head.        *)
Commits(k, h, l) ==
  /\ l = "active" /\ life = "active" /\ head = h /\ head < MaxRev
  /\ receipt[k] = None
  /\ (k = "stop" \/ Reason[k] \in ValidFailReasons)
Replays(k, h, l) == l /= "active" /\ receipt[k] = h - 1

TermOutcome(k, h, l) ==
  IF Commits(k, h, l) THEN "commit"
  ELSE IF Replays(k, h, l) THEN "replay" ELSE "error"

TermEffect(k, h, l) ==
  IF Commits(k, h, l)
  THEN /\ life' = Target(k)
       /\ head' = head + 1
       /\ why' = Reason[k]
       /\ receipt' = [receipt EXCEPT ![k] = h]
  ELSE UNCHANGED graphVars

\* A GET and its POSTs with nothing in between, used where no other actor's
\* step matters between them.
TermNow(k) == TermEffect(k, head, life)
TermNowOk(k) == TermOutcome(k, head, life) /= "error"

\* finalize_completion_execution_accepted / _failed (CEX:242-442): one
\* transaction; any mismatch rolls back and the caller retries.
CanFinalizeAccepted == phase \in {"launching", "attached"} /\ status = "running"
CanFinalizeFailed == phase \in {"launching", "attached"} /\ status \in Active

-----------------------------------------------------------------------------
(* complete_prepared_child (THR:1274-1552), one broker call per launcher. *)
LaunchCheck(l) ==
  /\ appUp /\ lpc[l] = "idle"
  /\ IF phase \in {"launching", "attached", "settled"}
     THEN lpc' = [lpc EXCEPT ![l] = "done"]          \* 200, no launch (:1332)
     ELSE lpc' = [lpc EXCEPT ![l] = "reserve"]
  /\ UNCHANGED <<graphVars, auth, phase, execWhy, status, prov, launches, appUp, semPc,
                 exitPc, cleanPc, stopPc, stopSeen, stopReport, restartPc>>

LaunchReserve(l) ==                                   \* reserve (CEX:37-105)
  /\ appUp /\ lpc[l] = "reserve"
  /\ phase' = IF phase = "none" THEN "reserved" ELSE phase
  /\ lpc' = [lpc EXCEPT ![l] = "claim"]
  /\ UNCHANGED <<graphVars, auth, status, execWhy, prov, launches, appUp, semPc,
                 exitPc, cleanPc, stopPc, stopSeen, stopReport, restartPc>>

LaunchClaim(l) ==                                     \* CAS (CEX:108-134)
  /\ appUp /\ lpc[l] = "claim"
  /\ IF phase = "reserved"
     THEN /\ phase' = "launching" /\ UNCHANGED execWhy
          /\ lpc' = [lpc EXCEPT ![l] = "activate"]
     ELSE /\ lpc' = [lpc EXCEPT ![l] = "done"]
          /\ UNCHANGED <<phase, execWhy>>
  /\ UNCHANGED <<graphVars, auth, status, prov, launches, appUp, semPc,
                 exitPc, cleanPc, stopPc, stopSeen, stopReport, restartPc>>

\* claim_and_activate (THR:1423-1465): claim running, remint the capability.
\* Ownership lost or activation failure settles the execution row only.
LaunchActivate(l, ok) ==
  /\ appUp /\ lpc[l] = "activate"
  /\ \/ /\ ok
        /\ status' = "running" /\ auth' = TRUE
        /\ lpc' = [lpc EXCEPT ![l] = "start"]
        /\ UNCHANGED <<phase, execWhy, graphVars>>
     \/ /\ ~ok
        /\ phase' = "settled" /\ execWhy' = "capability_activation_failed"
        /\ lpc' = [lpc EXCEPT ![l] = "done"]
        /\ UNCHANGED auth
        /\ IF ActivationFailureSettlesGraph   \* candidate fix: fail both stores
           THEN /\ TermNow("activate") /\ status' = "failed"
           ELSE UNCHANGED <<graphVars, status>>
  /\ UNCHANGED <<prov, launches, appUp, semPc, exitPc, cleanPc,
                 stopPc, stopSeen, stopReport, restartPc>>

LaunchStart(l, outcome) ==                            \* THR:1479-1506
  /\ appUp /\ lpc[l] = "start"
  /\ \/ /\ outcome = "ok"
        /\ prov' = "running" /\ launches' = launches + 1
        /\ lpc' = [lpc EXCEPT ![l] = "attach"]
        /\ UNCHANGED cleanPc
     \/ /\ outcome = "fail"
        /\ cleanPc' = "cancel"                        \* spawn cleanup (:1497)
        /\ lpc' = [lpc EXCEPT ![l] = "done"]
        /\ UNCHANGED <<prov, launches>>
     \/ /\ outcome = "lost"
        /\ cleanPc' = "cancel"      \* the start ran but its acknowledgement
        /\ lpc' = [lpc EXCEPT ![l] = "done"]  \* was lost (THR test :3229)
        /\ prov' = "running" /\ launches' = launches + 1
  /\ UNCHANGED <<graphVars, auth, phase, execWhy, status, appUp, semPc, exitPc,
                 stopPc, stopSeen, stopReport, restartPc>>

\* attach, then spawn both observers regardless (THR:1508-1532). A failed
\* attach cancels the provider and tries Fail(attachment_persist_failed).
LaunchAttach(l, ok) ==
  /\ appUp /\ lpc[l] = "attach"
  /\ semPc' = "watch" /\ exitPc' = "wait"
  /\ lpc' = [lpc EXCEPT ![l] = "done"]
  /\ \/ /\ ok
        /\ phase' = IF phase = "launching" THEN "attached" ELSE phase
        /\ UNCHANGED <<graphVars, prov, execWhy>>
     \/ /\ ~ok
        /\ prov' = IF prov = "running" THEN "cancelled" ELSE prov
        /\ TermNow("attach")
        /\ UNCHANGED <<phase, execWhy>>
  /\ UNCHANGED <<auth, status, launches, appUp, cleanPc, stopPc, stopSeen,
                 stopReport, restartPc>>

-----------------------------------------------------------------------------
(* The child model, through its graph capability (GS:1496-1558). Advance  *)
(* and Return need a live capability and an active current.               *)
ChildAdvance ==   \* leaves room under MaxRev for one terminal revision
  /\ prov = "running" /\ auth /\ life = "active" /\ head < MaxRev - 1
  /\ head' = head + 1
  /\ UNCHANGED <<life, why, receipt, auth, phase, execWhy, status, prov, launches,
                 appUp, actorVars>>

ChildReturn ==
  /\ prov = "running" /\ auth /\ life = "active" /\ head < MaxRev
  /\ life' = "succeeded" /\ head' = head + 1
  /\ UNCHANGED <<why, receipt, auth, phase, execWhy, status, prov, launches, appUp,
                 actorVars>>

\* The harness run ends. HH resolves the observation for any native settle
\* (host.ts:540-541), whether or not the child returned.
ProviderExit(outcome) ==
  /\ prov = "running"
  /\ prov' = outcome
  /\ UNCHANGED <<graphVars, auth, phase, execWhy, status, launches, appUp, actorVars>>

-----------------------------------------------------------------------------
(* Semantic observer (THR:1850-1990). It projects a terminal current into *)
(* the product store, retrying a rejected finalize every 250 ms forever.  *)
SemFinalize ==
  /\ appUp /\ semPc = "watch" /\ life /= "active"
  /\ IF life = "succeeded"
     THEN IF CanFinalizeAccepted
          THEN /\ phase' = "settled" /\ status' = "accepted" /\ execWhy' = "none"
               /\ semPc' = "done"
          ELSE UNCHANGED <<phase, execWhy, status, semPc>>       \* retry forever
     ELSE IF CanFinalizeFailed
          THEN /\ phase' = "settled" /\ status' = "failed" /\ execWhy' = why
               /\ semPc' = "done"
          ELSE UNCHANGED <<phase, execWhy, status, semPc>>
  /\ UNCHANGED <<graphVars, auth, prov, launches, appUp, lpc, exitPc, cleanPc,
                 stopPc, stopSeen, stopReport, restartPc>>

\* Twenty consecutive projection errors: cancel, then Fail(graph_observation_failed).
SemObservationFault ==
  /\ appUp /\ semPc = "watch" /\ life = "active"
  /\ prov' = IF prov = "running" THEN "cancelled" ELSE prov
  /\ TermNow("obs")
  /\ UNCHANGED <<auth, phase, execWhy, status, launches, appUp, actorVars>>

(* Provider-exit observer (THR:1992-2015). The observe GET has a 5 s     *)
(* timeout (RT:23, 1755-1764); an Err with an active current is failed.   *)
ExitObserve ==
  /\ appUp /\ exitPc = "wait"
  /\ \/ /\ prov = "exited_ok"
        /\ exitPc' = IF CleanExitIsChecked THEN "check" ELSE "discard"
     \/ /\ prov \in {"exited_err", "cancelled"}
        /\ exitPc' = "check"
     \/ /\ prov = "running" /\ ObserveTimesOut
        /\ exitPc' = "check"
  /\ UNCHANGED <<graphVars, auth, phase, execWhy, status, prov, launches, appUp, lpc,
                 semPc, cleanPc, stopPc, stopSeen, stopReport, restartPc>>

\* GET current, and if active, fail_graph_completion (itself GET + POST);
\* the result is ignored. The check and the fail are separate reads.
ExitCheckAndFail ==
  /\ appUp /\ exitPc = "check"
  /\ exitPc' = "discard"
  /\ IF life = "active" THEN TermNow("exit") ELSE UNCHANGED graphVars
  /\ UNCHANGED <<auth, phase, execWhy, status, prov, launches, appUp, lpc, semPc,
                 cleanPc, stopPc, stopSeen, stopReport, restartPc>>

\* discard_prepared revokes the child's capability.
ExitDiscard ==
  /\ appUp /\ exitPc = "discard"
  /\ auth' = FALSE /\ exitPc' = "done"
  /\ UNCHANGED <<graphVars, phase, execWhy, status, prov, launches, appUp, lpc, semPc,
                 cleanPc, stopPc, stopSeen, stopReport, restartPc>>

-----------------------------------------------------------------------------
(* Start-failure cleanup (THR:1554-1623): four sequential loops, each     *)
(* retrying every 250 ms until its step succeeds.                         *)
CleanCancel ==
  /\ appUp /\ cleanPc = "cancel"
  /\ cleanPc' = "fail"
  /\ prov' = IF prov = "running" THEN "cancelled" ELSE prov
  /\ UNCHANGED <<graphVars, auth, phase, execWhy, status, launches, appUp, lpc,
                 semPc, exitPc, stopPc, stopSeen, stopReport, restartPc>>

CleanFail ==
  /\ appUp /\ cleanPc = "fail"
  /\ TermNow("start")
  /\ cleanPc' = IF TermNowOk("start")
                   \/ (TerminalReadSettlesCleanup /\ life /= "active")
                THEN "finalize" ELSE "fail"
  /\ UNCHANGED <<auth, phase, execWhy, status, prov, launches, appUp, lpc, semPc,
                 exitPc, stopPc, stopSeen, stopReport, restartPc>>

\* Today it always finalizes as failed. With the candidate fix it finalizes
\* what the graph holds.
CleanFinalize ==
  /\ appUp /\ cleanPc = "finalize"
  /\ IF TerminalReadSettlesCleanup /\ life = "succeeded"
     THEN IF CanFinalizeAccepted
          THEN /\ phase' = "settled" /\ status' = "accepted" /\ execWhy' = "none"
               /\ cleanPc' = "discard"
          ELSE UNCHANGED <<phase, execWhy, status, cleanPc>>
     ELSE IF CanFinalizeFailed
     THEN /\ phase' = "settled" /\ status' = "failed" /\ cleanPc' = "discard"
          \* Today the reason is fixed; with the fix it is the graph's.
          /\ execWhy' = IF TerminalReadSettlesCleanup THEN why ELSE "provider_start_failed"
     ELSE UNCHANGED <<phase, execWhy, status, cleanPc>>
  /\ UNCHANGED <<graphVars, auth, prov, launches, appUp, lpc, semPc, exitPc,
                 stopPc, stopSeen, stopReport, restartPc>>

CleanDiscard ==
  /\ appUp /\ cleanPc = "discard"
  /\ auth' = FALSE /\ cleanPc' = "done"
  /\ UNCHANGED <<graphVars, phase, execWhy, status, prov, launches, appUp, lpc, semPc,
                 exitPc, stopPc, stopSeen, stopReport, restartPc>>

-----------------------------------------------------------------------------
(* Parent stop_completion (THR:1708-1759): settle the current first, then *)
(* cancel the provider. It does not retry a stale revision.               *)
\* The parent may stop once the child interaction is bound to its graph
\* node (authorize_child_completion, THR:1776-1804), even before launch.
StopRead ==
  /\ appUp /\ stopPc = "idle" /\ phase /= "none"
  /\ stopSeen' = [h |-> head, l |-> life]
  /\ stopPc' = "post"
  /\ UNCHANGED <<graphVars, auth, phase, execWhy, status, prov, launches, appUp, lpc,
                 semPc, exitPc, cleanPc, stopReport, restartPc>>

StopPost ==
  /\ appUp /\ stopPc = "post"
  /\ LET o == TermOutcome("stop", stopSeen.h, stopSeen.l)
     IN /\ TermEffect("stop", stopSeen.h, stopSeen.l)
        \* On error it re-reads: still active is an error, terminal reports it.
        /\ stopReport' = CASE o /= "error" -> "stopped"
                           [] life = "active" -> "error"
                           [] OTHER -> life
  /\ stopPc' = "cancel"
  /\ UNCHANGED <<auth, phase, execWhy, status, prov, launches, appUp, lpc, semPc,
                 exitPc, cleanPc, stopSeen, restartPc>>

StopCancel ==
  /\ appUp /\ stopPc = "cancel"
  /\ prov' = IF prov = "running" /\ stopReport /= "error" THEN "cancelled" ELSE prov
  /\ stopPc' = "done"
  /\ UNCHANGED <<graphVars, auth, phase, execWhy, status, launches, appUp, lpc, semPc,
                 exitPc, cleanPc, stopSeen, stopReport, restartPc>>

-----------------------------------------------------------------------------
(* Application restart. Every in-memory actor dies, the harness run and   *)
(* graph sessions end, and startup reconciles launched executions         *)
(* (APP:293-376) before serving.                                          *)
Crash ==
  /\ appUp /\ restartPc = "none"
  /\ appUp' = FALSE
  /\ prov' = IF prov = "running" THEN "exited_err" ELSE prov
  /\ auth' = FALSE
  /\ lpc' = [l \in Launchers |-> "dead"]
  /\ semPc' = "dead" /\ exitPc' = "dead" /\ cleanPc' = "dead"
  /\ stopPc' = IF stopPc = "done" THEN "done" ELSE "dead"
  /\ restartPc' = "reconcile"
  /\ UNCHANGED <<graphVars, phase, execWhy, status, launches, stopSeen, stopReport>>

\* A launched row maps the graph lifecycle into the product; an active one
\* is failed with application_restart first. Any error aborts startup (`?`).
RestartReconcile ==
  /\ restartPc = "reconcile"
  /\ IF phase \notin {"launching", "attached"}
     THEN /\ restartPc' = "done" /\ appUp' = TRUE
          /\ UNCHANGED <<graphVars, phase, execWhy, status>>
     ELSE IF life = "active"
     THEN /\ TermNow("restart")
          /\ UNCHANGED <<phase, execWhy, status, restartPc, appUp>>   \* then re-read
     ELSE IF (life = "succeeded" /\ CanFinalizeAccepted)
             \/ (life /= "succeeded" /\ CanFinalizeFailed)
     THEN /\ phase' = "settled"
          /\ status' = IF life = "succeeded" THEN "accepted" ELSE "failed"
          /\ execWhy' = IF life = "succeeded" THEN "none" ELSE why
          /\ restartPc' = "done" /\ appUp' = TRUE
          /\ UNCHANGED graphVars
     ELSE /\ restartPc' = "aborted"
          /\ UNCHANGED <<graphVars, phase, execWhy, status, appUp>>
  /\ UNCHANGED <<auth, prov, launches, lpc, semPc, exitPc, cleanPc, stopPc,
                 stopSeen, stopReport>>

-----------------------------------------------------------------------------
LaunchActivateAny(l) == \E ok \in BOOLEAN : LaunchActivate(l, ok)
LaunchStartAny(l) == \E o \in {"ok", "fail", "lost"} : LaunchStart(l, o)
LaunchAttachAny(l) == \E ok \in BOOLEAN : LaunchAttach(l, ok)
ProviderExitAny == \E o \in {"exited_ok", "exited_err"} : ProviderExit(o)

SystemStep ==
  \/ \E l \in Launchers : LaunchCheck(l) \/ LaunchReserve(l) \/ LaunchClaim(l)
                          \/ LaunchActivateAny(l) \/ LaunchStartAny(l)
                          \/ LaunchAttachAny(l)
  \/ SemFinalize
  \/ ExitObserve \/ ExitCheckAndFail \/ ExitDiscard
  \/ CleanCancel \/ CleanFail \/ CleanFinalize \/ CleanDiscard
  \/ StopPost \/ StopCancel
  \/ RestartReconcile

Next ==
  \/ SystemStep
  \/ StopRead                     \* the parent may stop, but need not
  \/ ChildAdvance \/ ChildReturn \/ ProviderExitAny
  \/ SemObservationFault
  \/ Crash

\* Every system actor keeps running while enabled, and a provider run
\* eventually ends. The child's model is not obliged to Advance or Return,
\* the parent is not obliged to stop it, and faults and crashes are not
\* obliged to happen.
Fairness ==
  /\ WF_vars(SystemStep)
  /\ \A l \in Launchers :
       /\ WF_vars(LaunchCheck(l)) /\ WF_vars(LaunchReserve(l))
       /\ WF_vars(LaunchClaim(l)) /\ WF_vars(LaunchActivateAny(l))
       /\ WF_vars(LaunchStartAny(l)) /\ WF_vars(LaunchAttachAny(l))
  /\ WF_vars(SemFinalize)
  /\ WF_vars(ExitObserve) /\ WF_vars(ExitCheckAndFail) /\ WF_vars(ExitDiscard)
  /\ WF_vars(CleanCancel) /\ WF_vars(CleanFail) /\ WF_vars(CleanFinalize)
  /\ WF_vars(CleanDiscard)
  /\ WF_vars(StopPost) /\ WF_vars(StopCancel)
  /\ WF_vars(RestartReconcile)
  /\ WF_vars(ProviderExitAny)

(* A scenario step is a tuple naming one action and its arguments, as the  *)
(* trace adapters name them (models/tla/scenarios.json). Launcher ids are  *)
(* numbers.                                                               *)
Act(s) ==
  LET n == s[1] IN
  CASE n = "LaunchCheck" -> LaunchCheck(s[2])
    [] n = "LaunchReserve" -> LaunchReserve(s[2])
    [] n = "LaunchClaim" -> LaunchClaim(s[2])
    [] n = "LaunchActivate" -> LaunchActivate(s[2], s[3] = "ok")
    [] n = "LaunchStart" -> LaunchStart(s[2], s[3])
    [] n = "LaunchAttach" -> LaunchAttach(s[2], s[3] = "ok")
    [] n = "ChildAdvance" -> ChildAdvance
    [] n = "ChildReturn" -> ChildReturn
    [] n = "ProviderExit" -> ProviderExit(s[2])
    [] n = "SemFinalize" -> SemFinalize
    [] n = "SemObservationFault" -> SemObservationFault
    [] n = "ExitObserve" -> ExitObserve
    [] n = "ExitCheckAndFail" -> ExitCheckAndFail
    [] n = "ExitDiscard" -> ExitDiscard
    [] n = "CleanCancel" -> CleanCancel
    [] n = "CleanFail" -> CleanFail
    [] n = "CleanFinalize" -> CleanFinalize
    [] n = "CleanDiscard" -> CleanDiscard
    [] n = "StopRead" -> StopRead
    [] n = "StopPost" -> StopPost
    [] n = "StopCancel" -> StopCancel
    [] n = "Crash" -> Crash
    [] n = "RestartReconcile" -> RestartReconcile

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Safety.                                                                *)

TypeOK ==
  /\ life \in {"active", "succeeded", "stopped", "failed"}
  /\ head \in 0..MaxRev
  /\ phase \in {"none", "reserved", "launching", "attached", "settled"}
  /\ status \in {"submitted", "running", "accepted", "failed"}
  /\ prov \in {"none", "running", "exited_ok", "exited_err", "cancelled"}

\* "claim_launching is the only transition that authorizes a provider
\* launch" (CEX:107).
AtMostOneLaunch == launches <= 1

\* ADR 0008: a terminal current is absorbing.
TerminalIsAbsorbing == [][life /= "active" => life' = life]_vars

\* PRD: "A stopped child reports stopped." What stop answered the parent
\* is what the graph holds.
StopReportIsTruthful ==
  stopReport \in {"stopped", "succeeded", "failed"} => stopReport = life

\* A child is never failed for exiting while its provider is still running.
NoExitFailureWhileRunning ==
  why = "provider_exited_without_return" => prov /= "running"

\* A settled execution has a terminal graph current, and the product
\* status agrees with it.
SettledExecutionAgreesWithGraph ==
  /\ phase = "settled" => life /= "active"
  /\ status = "accepted" => life = "succeeded"
  /\ (status = "failed" /\ phase = "settled") => life \in {"stopped", "failed"}

\* Startup never aborts on a state the product itself produced.
RestartNeverAborts == restartPc /= "aborted"

(* Liveness. PRD: a never-settling result is not the contract.            *)
Settled == life /= "active" /\ phase = "settled" /\ status \in {"accepted", "failed"}
LaunchedChildSettles == (launches > 0) ~> Settled
ClaimedChildSettles == (phase = "launching") ~> (phase = "settled" /\ life /= "active")

=============================================================================
