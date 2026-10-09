------------------------ MODULE CompletionLaunchWindows ------------------------
(***************************************************************************)
(* One recursive child from the parent's prepareComplete to settlement,   *)
(* focused on the launch windows the CompletionCurrent model abstracts:   *)
(* product preparation and binding, the execution row before `launching`, *)
(* capability activation, the thread's one active message turn, the       *)
(* user's re-invoke, invoke of another action, and Stop, and startup      *)
(* reconciliation of each window.                                         *)
(*                                                                         *)
(*   THR = crates/relayer-app-server/src/api/threads.rs                    *)
(*   APP = crates/relayer-app-server/src/app_server.rs                     *)
(*   AI  = crates/relayer-app-server/src/storage/sqlite/action_invocations.rs *)
(*   INT = crates/relayer-app-server/src/storage/sqlite/interactions.rs    *)
(*   STP = crates/relayer-app-server/src/storage/sqlite/stops.rs           *)
(*   CEX = crates/relayer-app-server/src/storage/sqlite/completion_executions.rs *)
(*                                                                         *)
(* Abstractions: one parent, one child. Admission, start, attach and the   *)
(* exit/semantic observers are one step each (CompletionCurrent models     *)
(* them). Each cleanup is one atomic step: the activation cleanup fails   *)
(* the graph current before the product rows, and the refused-launch      *)
(* cleanup fails the product row first. A crash restarts the harness with *)
(* the app. Graph and store errors at startup, the background retry after *)
(* them, and a crash inside a cleanup are not modeled.                    *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Launchers,            \* broker complete() calls the parent may make
  MaxRestarts,
  ActivationFailsGraph, \* fix: a failed activation fails the graph current and
                        \* the product row too (the launch-failure cleanup)
  StartupFailsUnlaunched, \* fix: startup fails an interrupted child that no
                        \* launched execution row covers, in both stores
  PrepareCanBeAmbiguous, \* the broker's graph preparation can end ambiguously
  RefusedLaunchFailsChild, \* fix: a launch refused after the child was claimed
                        \* fails it in both stores in the background
  ChildrenOutsideRootGate, \* decision: a child never holds the thread's one active
                        \* human turn (the gate on the user's next message)
  ProductLeavesChildren, \* decision: the product's Stop refuses an agent's child, and
                        \* a user's invoke never runs it
  InvokesOutsideRootGate \* decision (#717): a run the user starts from another invoke
                        \* action starts a fresh native session, so it never holds the
                        \* thread's one active message turn nor waits for it

Interrupted == {"not_started", "submitted", "running"}   \* HUMAN_TURN_IN_PROGRESS
Terminal == {"succeeded", "failed", "stopped"}

VARIABLES
  parent,     \* parent product status: running | accepted | stopped | failed
  pdead,      \* the parent's native run (and broker grant) is gone
  life,       \* child graph current: none | active | succeeded | failed | stopped
  status,     \* child product status: absent | not_started | submitted | running
              \*   | accepted | failed | pending (failed: reconciliation pending)
  bound,      \* child product row carries graph_node_id
  phase,      \* completion_executions: none | reserved | launching | attached | settled
  run,        \* broker-launched provider run: none | running | ended
  hrun,       \* product-path run started by the user's re-invoke: none | running | ended
  obs,        \* this process observes the launched child (semantic observer)
  stopReq,    \* interaction_stop_requests row for the child
  lpc,        \* launcher program counters
  appUp,
  restarts,
  startupLeftActive, \* the last startup left the child's current active
  called,     \* the parent has called the broker for this child
  cleanup,    \* a refused launch's background failure of the child is pending
  hturn,      \* the user's next message turn: none | running | ended
  uinvoke     \* a run the user started from another invoke action: none | running | ended

vars == <<parent, pdead, life, status, bound, phase, run, hrun, obs, stopReq, lpc,
          appUp, restarts, startupLeftActive, called, cleanup, hturn, uinvoke>>

Init ==
  /\ parent = "running" /\ pdead = FALSE
  /\ life = "none" /\ status = "absent" /\ bound = FALSE /\ phase = "none"
  /\ run = "none" /\ hrun = "none" /\ obs = FALSE /\ stopReq = FALSE
  /\ lpc = [l \in Launchers |-> "idle"]
  /\ appUp = TRUE /\ restarts = 0 /\ startupLeftActive = FALSE /\ called = FALSE /\ cleanup = FALSE
  /\ hturn = "none" /\ uinvoke = "none"

ParentAlive == parent = "running" /\ ~pdead /\ appUp

-----------------------------------------------------------------------------
(* The parent agent.                                                       *)

\* graph.prepareComplete(delegate): the graph creates the child and its current.
ParentPrepares ==
  /\ ParentAlive /\ life = "none"
  /\ life' = "active"
  /\ UNCHANGED <<parent, pdead, status, bound, phase, run, hrun, obs, stopReq, lpc,
                 appUp, restarts, startupLeftActive, called, cleanup, hturn, uinvoke>>

\* The parent's native run ends (Return, giving up after a refusal, or
\* fire-and-forget), or the user stops it. Either revokes its broker grant.
ParentEnds(outcome) ==
  /\ ParentAlive
  /\ parent' = outcome
  /\ UNCHANGED <<pdead, life, status, bound, phase, run, hrun, obs, stopReq, lpc,
                 appUp, restarts, startupLeftActive, called, cleanup, hturn, uinvoke>>

\* handle.stop (THR stop_completion): stop the current, then cancel the run.
ParentStopsChild ==
  /\ ParentAlive /\ bound /\ life = "active"
  /\ life' = "stopped"
  /\ run' = IF run = "running" THEN "ended" ELSE run
  /\ UNCHANGED <<parent, pdead, status, bound, phase, hrun, obs, stopReq, lpc, appUp,
                 restarts, startupLeftActive, called, cleanup, hturn, uinvoke>>

-----------------------------------------------------------------------------
(* One broker POST /api/completions (THR launch_prepared_child).          *)
Set(l, pc) == lpc' = [lpc EXCEPT ![l] = pc]

BrokerCall(l) ==
  /\ ParentAlive /\ lpc[l] = "idle" /\ life /= "none"
  /\ Set(l, "check") /\ called' = TRUE
  /\ UNCHANGED <<parent, pdead, life, status, bound, phase, run, hrun, obs, stopReq,
                 appUp, restarts, startupLeftActive, cleanup, hturn, uinvoke>>

\* invoke_action_recursively creates the product child. An execution row past
\* `reserved`, or a child that already ended, answers 200 with no launch.
LaunchCheck(l) ==
  /\ appUp /\ lpc[l] = "check"
  /\ status' = IF status = "absent" THEN "not_started" ELSE status
  /\ Set(l, IF phase \in {"none", "reserved"}
                /\ status \notin {"accepted", "failed", "pending"}
            THEN "prepare" ELSE "done")
  /\ UNCHANGED <<parent, pdead, life, bound, phase, run, hrun, obs, stopReq, appUp,
                 restarts, startupLeftActive, called, cleanup, hturn, uinvoke>>

\* THR prepare_interaction: claim `submitted`, then the idempotent graph
\* preparation. An ambiguous one (timeout, transport, undecodable answer) is
\* refused; with the fix, that refusal spawns the refused-launch cleanup.
LaunchPrepare(l, ok) ==
  /\ appUp /\ lpc[l] = "prepare"
  /\ IF status \notin {"not_started", "submitted"}
     THEN /\ Set(l, "done") /\ UNCHANGED <<status, cleanup>>
     ELSE /\ status' = "submitted"
          /\ Set(l, IF ok THEN "bind" ELSE "done")
          /\ cleanup' = IF ~ok /\ RefusedLaunchFailsChild THEN TRUE ELSE cleanup
  /\ UNCHANGED <<parent, pdead, life, bound, phase, run, hrun, obs, stopReq, appUp,
                 restarts, startupLeftActive, called, hturn, uinvoke>>

LaunchBind(l) ==                                           \* bind_prepared_interaction
  /\ appUp /\ lpc[l] = "bind"
  /\ bound' = TRUE /\ Set(l, "reserve")
  /\ UNCHANGED <<parent, pdead, life, status, phase, run, hrun, obs, stopReq, appUp,
                 restarts, startupLeftActive, called, cleanup, hturn, uinvoke>>

LaunchReserve(l) ==                                        \* reserve_completion_execution
  /\ appUp /\ lpc[l] = "reserve"
  /\ phase' = IF phase = "none" THEN "reserved" ELSE phase
  /\ Set(l, "claim")
  /\ UNCHANGED <<parent, pdead, life, status, bound, run, hrun, obs, stopReq, appUp,
                 restarts, startupLeftActive, called, cleanup, hturn, uinvoke>>

LaunchClaim(l) ==                                          \* claim ..._launching (CAS)
  /\ appUp /\ lpc[l] = "claim"
  /\ IF phase = "reserved"
     THEN phase' = "launching" /\ Set(l, "activate")
     ELSE UNCHANGED phase /\ Set(l, "done")
  /\ UNCHANGED <<parent, pdead, life, status, bound, run, hrun, obs, stopReq, appUp,
                 restarts, startupLeftActive, called, cleanup, hturn, uinvoke>>

\* THR claim_and_activate_prepared_interaction: the claim needs `submitted`;
\* activation can fail (graph 5xx, visual-asset cutover, a terminal current).
\* With the fix, a failure after the claim fails both stores (the launch-failure
\* cleanup); a row another path claimed first settles as ownership lost. Before
\* the fix, every failure settled the execution row only.
LaunchActivate(l, ok) ==
  /\ appUp /\ lpc[l] = "activate"
  /\ IF status = "submitted" /\ ok /\ life = "active"
     THEN /\ status' = "running" /\ Set(l, "start")
          /\ UNCHANGED <<life, phase>>
     ELSE /\ Set(l, "done")
          /\ phase' = "settled"
          /\ IF status = "submitted" /\ ActivationFailsGraph
             THEN /\ life' = IF life = "active" THEN "failed" ELSE life
                  /\ status' = "failed"
             ELSE UNCHANGED <<life, status>>
  /\ UNCHANGED <<parent, pdead, bound, run, hrun, obs, stopReq, appUp, restarts,
                 startupLeftActive, called, cleanup, hturn, uinvoke>>

\* Admission, start, attach and spawning the observers.
LaunchStart(l) ==
  /\ appUp /\ lpc[l] = "start"
  /\ run' = "running" /\ phase' = "attached" /\ obs' = TRUE
  /\ Set(l, "done")
  /\ UNCHANGED <<parent, pdead, life, status, bound, hrun, stopReq, appUp, restarts,
                 startupLeftActive, called, cleanup, hturn, uinvoke>>

\* The child Returns, or the exit observer fails a run that ended without Return.
ChildEnds(outcome) ==
  /\ run = "running" /\ life = "active"
  /\ life' = outcome /\ run' = "ended"
  /\ UNCHANGED <<parent, pdead, status, bound, phase, hrun, obs, stopReq, lpc, appUp,
                 restarts, startupLeftActive, called, cleanup, hturn, uinvoke>>

\* The semantic observer projects the terminal current (THR spawn_recursive_completion_observers).
ObserverSettles ==
  /\ appUp /\ obs /\ phase \in {"launching", "attached"} /\ life \in Terminal
  /\ status \in {"submitted", "running"}
  /\ phase' = "settled" /\ obs' = FALSE
  /\ status' = IF life = "succeeded" THEN "accepted" ELSE "failed"
  /\ UNCHANGED <<parent, pdead, life, bound, run, hrun, stopReq, lpc, appUp, restarts,
                 startupLeftActive, called, cleanup, hturn, uinvoke>>

\* THR spawn_refused_launch_cleanup: retries until the product row and then the
\* graph current are both failed (CEX fail_unlaunched_recursive_child), and a
\* reserved execution row settles with them. The product row fails first, which
\* fences out a later launch's reservation and claim. A launch past its claim, or
\* a product-path run, owns the child instead.
RefusedCleanup ==
  /\ appUp /\ cleanup
  /\ cleanup' = FALSE
  /\ IF status \in {"not_started", "submitted"} /\ phase \in {"none", "reserved"}
        /\ hrun /= "running"
     THEN /\ life' = IF life = "active" THEN "failed" ELSE life
          /\ status' = "failed"
          /\ phase' = IF phase = "reserved" THEN "settled" ELSE phase
     ELSE UNCHANGED <<life, status, phase>>
  /\ UNCHANGED <<parent, pdead, bound, run, hrun, obs, stopReq, lpc, appUp,
                 restarts, startupLeftActive, called, hturn, uinvoke>>

-----------------------------------------------------------------------------
(* The user.                                                               *)

\* Invoking the parent's delegate action again (THR invoke_action) resumed a
\* `submitted` leased child through the product path, only from an accepted
\* parent. With the decision, a user's invoke never runs an agent's child.
UserReinvokes ==
  /\ ~ProductLeavesChildren
  /\ appUp /\ parent = "accepted" /\ status = "submitted" /\ hrun = "none"
  /\ life = "active"
  /\ status' = "running" /\ hrun' = "running" /\ bound' = TRUE
  /\ UNCHANGED <<parent, pdead, life, phase, run, obs, stopReq, lpc, appUp, restarts,
                 startupLeftActive, called, cleanup, hturn, uinvoke>>

HumanRunEnds(outcome) ==
  /\ appUp /\ hrun = "running" /\ life = "active"
  /\ life' = outcome /\ hrun' = "ended"
  /\ status' = IF outcome = "succeeded" THEN "accepted" ELSE "failed"
  /\ UNCHANGED <<parent, pdead, bound, phase, run, obs, stopReq, lpc, appUp, restarts,
                 startupLeftActive, called, cleanup, hturn, uinvoke>>

\* Product Stop (STP request_interaction_stop). Before the decision it was
\* accepted for a child without an execution row, and nothing in-session acted
\* on it. Now the product refuses to stop an agent's child at all.
UserStopsChild ==
  /\ ~ProductLeavesChildren
  /\ appUp /\ phase = "none" /\ status \in {"submitted", "running"} /\ hrun /= "running"
  /\ stopReq' = TRUE
  /\ UNCHANGED <<parent, pdead, life, status, bound, phase, run, hrun, obs, lpc, appUp,
                 restarts, startupLeftActive, called, cleanup, hturn, uinvoke>>

\* The user sends the thread's next message (INT insert_interaction). The gate
\* (MESSAGE_TURN_IN_PROGRESS) refuses it while a message turn is in progress: the
\* parent's own turn, and before the decisions also the child and the user's
\* invoked run.
HumanTurnInProgress ==
  \/ parent = "running"
  \/ hturn = "running"
  \/ (~ChildrenOutsideRootGate /\ status \in Interrupted)
  \/ (~InvokesOutsideRootGate /\ uinvoke = "running")

UserSends ==
  /\ appUp /\ hturn = "none" /\ ~HumanTurnInProgress
  /\ hturn' = "running"
  /\ UNCHANGED <<parent, pdead, life, status, bound, phase, run, hrun, obs, stopReq, lpc,
                 appUp, restarts, startupLeftActive, called, cleanup, uinvoke>>

\* The user invokes another accepted action (AI insert_action_invocation). Its run
\* starts a fresh native session (THR execute_prepared_interaction sends
\* nativeSession: fresh) and runs beside the message turns. Before the decision
\* the gate refused it while a human turn ran.
UserInvokes ==
  /\ appUp /\ uinvoke = "none"
  /\ (InvokesOutsideRootGate \/ ~HumanTurnInProgress)
  /\ uinvoke' = "running"
  /\ UNCHANGED <<parent, pdead, life, status, bound, phase, run, hrun, obs, stopReq, lpc,
                 appUp, restarts, startupLeftActive, called, cleanup, hturn>>

UserInvokeEnds ==
  /\ appUp /\ uinvoke = "running"
  /\ uinvoke' = "ended"
  /\ UNCHANGED <<parent, pdead, life, status, bound, phase, run, hrun, obs, stopReq, lpc,
                 appUp, restarts, startupLeftActive, called, cleanup, hturn>>

HumanTurnEnds ==
  /\ appUp /\ hturn = "running"
  /\ hturn' = "ended"
  /\ UNCHANGED <<parent, pdead, life, status, bound, phase, run, hrun, obs, stopReq, lpc,
                 appUp, restarts, startupLeftActive, called, cleanup, uinvoke>>

-----------------------------------------------------------------------------
(* Crash and startup.                                                      *)

Crash ==
  /\ appUp /\ restarts < MaxRestarts
  /\ appUp' = FALSE /\ pdead' = TRUE /\ obs' = FALSE
  /\ run' = IF run = "running" THEN "ended" ELSE run      \* harness restarts too
  /\ hrun' = IF hrun = "running" THEN "ended" ELSE hrun
  /\ lpc' = [l \in Launchers |-> IF lpc[l] \in {"idle", "done"} THEN lpc[l] ELSE "dead"]
  /\ cleanup' = FALSE
  /\ hturn' = IF hturn = "running" THEN "ended" ELSE hturn   \* the turn fails with the app
  /\ uinvoke' = IF uinvoke = "running" THEN "ended" ELSE uinvoke
  /\ UNCHANGED <<parent, life, status, bound, phase, stopReq, restarts, startupLeftActive, called>>

\* APP reconcile_interrupted_work, in order.
Startup ==
  /\ ~appUp
  /\ LET \* 1. launched rows (reconcile_interrupted_recursive_completion_executions)
         launched == phase \in {"launching", "attached"}
         l1 == IF launched /\ life = "active" THEN "failed" ELSE life
         s1 == IF launched /\ status \in {"submitted", "running"}
               THEN IF l1 = "succeeded" THEN "accepted" ELSE "failed" ELSE status
         p1 == IF launched THEN "settled" ELSE phase
         \* 2. interrupted interactions (reconcile_interrupted_interaction). Before
         \*    the fix, the expected invocation was read only while the source was
         \*    accepted or running (AI invocation_graph_source); the fix reads the
         \*    occurrence whatever its status (AI invocation_graph_occurrence).
         expected == StartupFailsUnlaunched \/ parent \in {"accepted", "running"}
         inLoop == s1 \in Interrupted
         b2 == IF inLoop /\ ~bound /\ expected /\ l1 /= "none" THEN TRUE ELSE bound
         mismatch == inLoop /\ b2 /\ ~expected
         \* Before the fix: only a pending Stop failed a bound, active child.
         l2before == IF inLoop /\ b2 /\ expected /\ l1 = "active" /\ stopReq
                     THEN "failed" ELSE l1
         s2before == CASE mismatch -> "pending"
                       [] inLoop /\ b2 /\ l1 = "succeeded" -> "accepted"
                       [] inLoop /\ b2 /\ l1 /= l2before -> "failed"
                       [] OTHER -> s1
         \* The fix (fail_interrupted_recursive_child): every interrupted child
         \* that no launched row covers fails in both stores (application_restart),
         \* bound or not, whatever its source's status, and a reserved row settles;
         \* a succeeded one is accepted.
         l2 == IF StartupFailsUnlaunched /\ inLoop
               THEN IF l1 = "active" THEN "failed" ELSE l1 ELSE l2before
         s2 == IF StartupFailsUnlaunched /\ inLoop
               THEN IF l1 = "succeeded" THEN "accepted" ELSE "failed" ELSE s2before
         p2 == IF StartupFailsUnlaunched /\ inLoop /\ l1 /= "succeeded" /\ p1 = "reserved"
               THEN "settled" ELSE p1
         \* 3. leased invocation results stay `submitted` (AI recover_interrupted_action_invocations).
         s3 == IF s2 \in Interrupted THEN "submitted" ELSE s2
     IN /\ life' = l2 /\ status' = s3 /\ phase' = p2 /\ bound' = b2
        \* Product-visible only: a current the product never recorded is left out.
        /\ startupLeftActive' = (l2 = "active" /\ s3 \in Interrupted)
  \* 4. ordinary running interactions fail (INT recover_interrupted_interactions).
  /\ parent' = IF parent = "running" THEN "failed" ELSE parent
  /\ appUp' = TRUE /\ restarts' = restarts + 1
  /\ UNCHANGED <<pdead, run, hrun, obs, stopReq, lpc, called, cleanup, hturn, uinvoke>>

-----------------------------------------------------------------------------
LaunchStep(l) ==
  \/ LaunchCheck(l) \/ LaunchPrepare(l, TRUE)
  \/ (PrepareCanBeAmbiguous /\ LaunchPrepare(l, FALSE))
  \/ LaunchBind(l) \/ LaunchReserve(l) \/ LaunchClaim(l)
  \/ LaunchActivate(l, TRUE) \/ LaunchActivate(l, FALSE) \/ LaunchStart(l)

Next ==
  \/ ParentPrepares \/ ParentEnds("accepted") \/ ParentEnds("stopped")
  \/ ParentStopsChild
  \/ \E l \in Launchers : BrokerCall(l) \/ LaunchStep(l)
  \/ ChildEnds("succeeded") \/ ChildEnds("failed") \/ ObserverSettles
  \/ UserReinvokes \/ HumanRunEnds("succeeded") \/ HumanRunEnds("failed")
  \/ UserStopsChild \/ RefusedCleanup
  \/ UserSends \/ HumanTurnEnds \/ UserInvokes \/ UserInvokeEnds
  \/ Crash \/ Startup

\* The code's own steps run while enabled; a provider run eventually ends.
\* The parent, the user and crashes are under no obligation.
Fairness ==
  /\ \A l \in Launchers :
       WF_vars(LaunchCheck(l) \/ LaunchPrepare(l, TRUE)
               \/ (PrepareCanBeAmbiguous /\ LaunchPrepare(l, FALSE))
               \/ LaunchBind(l) \/ LaunchReserve(l) \/ LaunchClaim(l)
               \/ LaunchActivate(l, TRUE) \/ LaunchActivate(l, FALSE) \/ LaunchStart(l))
  /\ WF_vars(ChildEnds("succeeded") \/ ChildEnds("failed"))
  /\ WF_vars(HumanRunEnds("succeeded") \/ HumanRunEnds("failed"))
  /\ WF_vars(ObserverSettles)
  /\ WF_vars(Startup)
  /\ WF_vars(RefusedCleanup)

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
TypeOK ==
  /\ parent \in {"running", "accepted", "stopped", "failed"}
  /\ life \in {"none", "active"} \cup Terminal
  /\ status \in {"absent", "pending", "accepted", "failed"} \cup Interrupted
  /\ phase \in {"none", "reserved", "launching", "attached", "settled"}
  /\ run \in {"none", "running", "ended"} /\ hrun \in {"none", "running", "ended"}

\* CODE (CompletionCurrent SettledExecutionAgreesWithGraph): a settled execution
\* row has a terminal graph current and a terminal product status.
\* A user re-invoke racing a broker launch runs the child on the product path
\* while the broker row settles as ownership lost; that run is left out here.
SettledRowIsTerminal ==
  (appUp /\ phase = "settled" /\ hrun = "none") => (life \in Terminal /\ status \notin Interrupted)

\* PRD 1.4: "Restart never reattaches. Interrupted active completions fail
\* safely with application_restart and keep their retained current."
StartupFailsActiveChildren == ~startupLeftActive

\* PRD 12.2 (decision): only human root turns hold the thread. Once the parent's
\* turn is done and no other human turn runs, the user can always send; the
\* child's state never refuses it.
SendNeverWaitsOnChild ==
  (appUp /\ parent /= "running" /\ hturn = "none") => ENABLED UserSends

\* The one-active-message-turn gate still holds: two message turns never run at once.
OneHumanTurn == ~(parent = "running" /\ hturn = "running")

\* PRD 12.2 (decision, #717): a run the user starts from an invoke action never
\* waits for a message turn, the child, or another run.
InvokeNeverWaits == (appUp /\ uinvoke = "none") => ENABLED UserInvokes

\* PRD 12.2 (decision): only the parent agent stops or runs its child. The product
\* neither records a Stop for it nor runs it on the product path.
ProductLeavesChildAlone == hrun = "none" /\ ~stopReq

\* PRD 1.4: "A never-settling promise is not the contract. An awaiting agent
\* must be able to observe child termination."
ChildCurrentSettles == (called /\ life = "active") ~> (life \in Terminal)

\* The same, for a child the product has recorded. A crash after prepareComplete
\* but before the broker's first product write leaves a graph-only child that no
\* product row names, so startup cannot find it (known open: `launch-graph-orphan`).
RecordedChildCurrentSettles ==
  (called /\ status /= "absent" /\ life = "active") ~> (life \in Terminal)

\* The child's product row ends too: once the parent is done and nothing runs
\* the child, its turn eventually leaves the interrupted states.
ChildRowSettles ==
  (appUp /\ parent /= "running" /\ status \in Interrupted)
    ~> (status \notin Interrupted)
=============================================================================
