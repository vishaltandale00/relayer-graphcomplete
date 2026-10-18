---------------------------- MODULE NodeRunQueue ----------------------------
(***************************************************************************)
(* Runs a user starts on nodes (#718, PRD 12.2 PAR-007 to PAR-010).        *)
(* Runs on different nodes run at once. On one node they run in order:    *)
(* while a run holds its node, a new one waits as `queued`, and the next   *)
(* queued run starts when the run ahead settles, whatever its outcome. A   *)
(* queued run reads the thread when it starts, and a Stop ends it before   *)
(* it starts. A restart never leaves a run queued behind a run that no     *)
(* longer exists: it pauses the queued runs and interrupts the executing   *)
(* ones, and nothing starts either until the user resumes it (#722). Only  *)
(* the head of a node's paused chain resumes, and the chain behind it      *)
(* resumes with it, in order.                                              *)
(*                                                                         *)
(*   NQ  = crates/relayer-app-server/src/api/node_runs.rs                  *)
(*   THR = crates/relayer-app-server/src/api/threads.rs                    *)
(*   NR  = crates/relayer-app-server/src/storage/sqlite/node_runs.rs       *)
(*   STP = crates/relayer-app-server/src/storage/sqlite/stops.rs           *)
(*   AI  = crates/relayer-app-server/src/storage/sqlite/action_invocations.rs *)
(*   INT = crates/relayer-app-server/src/storage/sqlite/interactions.rs    *)
(*   PR  = crates/relayer-app-server/src/storage/sqlite/paused_runs.rs     *)
(*                                                                         *)
(* Runs are numbered in the order they were created, which is the order a  *)
(* node's queue starts them (NR queued_node_runs orders by sequence).      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  SameNode,           \* how many runs the user starts on node 1
  OtherNode,          \* how many runs the user starts on node 2
  MaxRestarts,
  AtomicAdmission,    \* fix: admission checks and takes the node in one step,
                      \* under the queue's lock (NQ admit)
  ReleaseOnSettle,    \* decision 4 (#716): a run that settles hands its node on
                      \* whatever its outcome (THR start_held_action_interaction)
  ContextAtStart,     \* decision 3 (#716): a run reads the thread's accepted
                      \* turns when it starts (execution accepted_thread_history)
  StartupPausesQueued, \* fix: startup ends the wait of a queued run by pausing
                      \* it (PR pause_queued_runs)
  ResumeHeadOnly,     \* decision (#721): only the head of a node's paused chain
                      \* resumes, and it resumes the chain (THR resume_interaction)
  AutoResume          \* the bug: startup restarted a run it had interrupted on its
                      \* own (the retired resume_recovered_identified_interactions)

Runs == 1..(SameNode + OtherNode)
NodeOf(r) == IF r <= SameNode THEN 1 ELSE 2
Nodes == {1, 2}

\* unsent: not sent yet. checked: admission saw the node free but has not taken
\* it (only without AtomicAdmission). interrupted: a restart ended it while it
\* executed. paused: a restart ended its wait in the queue. Neither is active,
\* and each waits for the user's Resume or Discard.
Statuses == {"unsent", "checked", "queued", "running", "accepted", "failed",
             "stopped", "interrupted", "paused"}
Settled == {"accepted", "failed", "stopped"}
Resumable == {"interrupted", "paused"}

VARIABLES
  status,     \* run -> Statuses
  holder,     \* node -> the run holding it, or 0. Live state: lost on a crash.
  seen,       \* run -> the accepted runs its context points at
  appUp,
  restarts,
  stoppedByRestart, \* ghost: the runs a startup paused or interrupted
  released    \* ghost: the runs the user resumed or discarded

vars == <<status, holder, seen, appUp, restarts, stoppedByRestart, released>>

TypeOK ==
  /\ status \in [Runs -> Statuses]
  /\ holder \in [Nodes -> Runs \cup {0}]
  /\ seen \in [Runs -> SUBSET Runs]
  /\ appUp \in BOOLEAN
  /\ restarts \in 0..MaxRestarts
  /\ stoppedByRestart \subseteq Runs
  /\ released \subseteq Runs

Init ==
  /\ status = [r \in Runs |-> "unsent"]
  /\ holder = [n \in Nodes |-> 0]
  /\ seen = [r \in Runs |-> {}]
  /\ appUp = TRUE
  /\ restarts = 0
  /\ stoppedByRestart = {}
  /\ released = {}

Accepted(st) == {r \in Runs : st[r] = "accepted"}
OnNode(r) == {o \in Runs : NodeOf(o) = NodeOf(r) /\ o /= r}

\* What a run's context points at: the accepted runs, read when it starts. Before
\* decision 3 it was read when the run was sent, even if the run then waited.
Admit(r) ==
  IF holder[NodeOf(r)] = 0
  THEN /\ status' = [status EXCEPT ![r] = "running"]
       /\ holder' = [holder EXCEPT ![NodeOf(r)] = r]
       /\ seen' = [seen EXCEPT ![r] = Accepted(status)]
  ELSE /\ status' = [status EXCEPT ![r] = "queued"]   \* NR queue_node_run
       /\ holder' = holder
       /\ seen' = IF ContextAtStart THEN seen ELSE [seen EXCEPT ![r] = Accepted(status)]

-----------------------------------------------------------------------------
(* The user sends a run (THR finish_action_handoff ->                        *)
(* claim_and_start_action_interaction).                                     *)

\* Without the lock, the check and the take are separate steps: a second run
\* can pass the check before the first takes the node.
Send(r) ==
  /\ appUp /\ status[r] = "unsent"
  /\ IF AtomicAdmission
     THEN Admit(r)
     ELSE /\ status' = [status EXCEPT ![r] =
                           IF holder[NodeOf(r)] = 0 THEN "checked" ELSE "queued"]
          /\ holder' = holder
          /\ seen' = IF ContextAtStart THEN seen ELSE [seen EXCEPT ![r] = Accepted(status)]
  /\ UNCHANGED <<appUp, restarts, stoppedByRestart, released>>

Take(r) ==
  /\ appUp /\ status[r] = "checked"
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ holder' = [holder EXCEPT ![NodeOf(r)] = r]
  /\ seen' = IF ContextAtStart THEN [seen EXCEPT ![r] = Accepted(status)] ELSE seen
  /\ UNCHANGED <<appUp, restarts, stoppedByRestart, released>>

-----------------------------------------------------------------------------
(* After a restart (#722). The runs a restart stopped on a node form a      *)
(* chain in creation order (PR restart_chain). Resume claims the chain      *)
(* (PR claim_restart_runs), and its runs take their places in the node's    *)
(* queue in order before the head starts (THR resume_runs). The head starts *)
(* if the node is free; the rest wait behind it as queued. Discard ends a   *)
(* run stopped and keeps its text (PR discard_restart_run).                 *)

Chain(n) == {o \in Runs : NodeOf(o) = n /\ status[o] \in Resumable}
IsHead(r) == \A o \in Chain(NodeOf(r)) : r <= o

\* Reverted, a Resume of a run inside the chain started just that run.
Resumed(r) == IF ResumeHeadOnly THEN Chain(NodeOf(r)) ELSE {r}

Resume(r) ==
  /\ appUp /\ status[r] \in Resumable
  /\ ResumeHeadOnly => IsHead(r)
  /\ LET n == NodeOf(r)
         runs == Resumed(r)
         starts == holder[n] = 0
     IN /\ status' = [o \in Runs |->
              IF o = r /\ starts THEN "running"
              ELSE IF o \in runs THEN "queued" ELSE status[o]]
        /\ holder' = IF starts THEN [holder EXCEPT ![n] = r] ELSE holder
        /\ seen' = IF starts THEN [seen EXCEPT ![r] = Accepted(status)] ELSE seen
        /\ released' = released \cup runs
  /\ UNCHANGED <<appUp, restarts, stoppedByRestart>>

Discard(r) ==
  /\ appUp /\ status[r] \in Resumable
  /\ status' = [status EXCEPT ![r] = "stopped"]
  /\ released' = released \cup {r}
  /\ UNCHANGED <<holder, seen, appUp, restarts, stoppedByRestart>>

\* Startup finds that the graph accepted an interrupted run's result after all,
\* and records it (APP reconcile_interrupted_interaction). Nothing reruns it.
RecoverAccepted(r) ==
  /\ appUp /\ status[r] = "interrupted"
  /\ status' = [status EXCEPT ![r] = "accepted"]
  /\ UNCHANGED <<holder, seen, appUp, restarts, stoppedByRestart, released>>

\* The bug, reverted only: startup ran an interrupted run again on its own.
AutoStart(r) ==
  /\ appUp /\ AutoResume /\ status[r] \in Resumable
  /\ holder[NodeOf(r)] = 0
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ holder' = [holder EXCEPT ![NodeOf(r)] = r]
  /\ seen' = [seen EXCEPT ![r] = Accepted(status)]
  /\ UNCHANGED <<appUp, restarts, stoppedByRestart, released>>

-----------------------------------------------------------------------------
(* A run settles, and its node passes to the oldest queued run (NQ release, *)
(* NR claim_queued_node_run).                                               *)

Oldest(n, st) ==
  LET waiting == {o \in Runs : NodeOf(o) = n /\ st[o] = "queued"}
  IN IF waiting = {} THEN 0 ELSE CHOOSE o \in waiting : \A w \in waiting : o <= w

Settle(r, outcome) ==
  /\ appUp /\ status[r] = "running"
  /\ LET n == NodeOf(r)
         settledStatus == [status EXCEPT ![r] = outcome]
         hands == holder[n] = r /\ (ReleaseOnSettle \/ outcome = "accepted")
         next == IF hands THEN Oldest(n, settledStatus) ELSE 0
     IN /\ status' = IF next = 0 THEN settledStatus
                     ELSE [settledStatus EXCEPT ![next] = "running"]
        /\ holder' = IF ~hands THEN holder
                     ELSE [holder EXCEPT ![n] = next]
        /\ seen' = IF next /= 0 /\ ContextAtStart
                   THEN [seen EXCEPT ![next] = Accepted(settledStatus)]
                   ELSE seen
  /\ UNCHANGED <<appUp, restarts, stoppedByRestart, released>>

\* STP request_interaction_stop: a queued run stops at once, never starting.
StopQueued(r) ==
  /\ appUp /\ status[r] = "queued"
  /\ status' = [status EXCEPT ![r] = "stopped"]
  /\ UNCHANGED <<holder, seen, appUp, restarts, stoppedByRestart, released>>

-----------------------------------------------------------------------------
(* Crash and startup. Startup interrupts executing runs and pauses queued   *)
(* ones; nothing starts on its own (#722). A second startup leaves paused   *)
(* and interrupted runs as they are.                                        *)

Crash ==
  /\ appUp /\ restarts < MaxRestarts
  /\ appUp' = FALSE
  /\ holder' = [n \in Nodes |-> 0]
  /\ UNCHANGED <<status, seen, restarts, stoppedByRestart, released>>

StoppedAtStartup(r) ==
  status[r] \in {"running", "checked"} \/ (StartupPausesQueued /\ status[r] = "queued")

Startup ==
  /\ ~appUp
  /\ status' = [r \in Runs |->
       IF status[r] \in {"running", "checked"} THEN "interrupted"
       ELSE IF StartupPausesQueued /\ status[r] = "queued" THEN "paused"
       ELSE status[r]]
  /\ stoppedByRestart' = stoppedByRestart \cup {r \in Runs : StoppedAtStartup(r)}
  /\ released' = released \ {r \in Runs : StoppedAtStartup(r)}
  /\ appUp' = TRUE /\ restarts' = restarts + 1
  /\ UNCHANGED <<holder, seen>>

-----------------------------------------------------------------------------
Next ==
  \/ \E r \in Runs : Send(r) \/ Take(r) \/ Resume(r) \/ Discard(r) \/ AutoStart(r)
                     \/ StopQueued(r) \/ RecoverAccepted(r)
  \/ \E r \in Runs, outcome \in Settled : Settle(r, outcome)
  \/ Crash \/ Startup

Spec == Init /\ [][Next]_vars

\* Code steps run while enabled, and a provider run eventually ends.
FairSpec ==
  /\ Spec
  /\ \A r \in Runs : WF_vars(Take(r))
  /\ \A r \in Runs : WF_vars(\E outcome \in Settled : Settle(r, outcome))
  /\ WF_vars(Startup)

-----------------------------------------------------------------------------
(* Promises.                                                               *)

\* PRD 12.2 (#718): two runs on one node never run at once.
OneRunPerNode ==
  \A r \in Runs : \A o \in OnNode(r) : ~(status[r] = "running" /\ status[o] = "running")

\* The issue's property: a queued run never starts while another run on its node is active.
QueuedNeverStartsWhileActive ==
  [][\A r \in Runs :
       (status[r] = "queued" /\ status'[r] = "running")
         => \A o \in OnNode(r) : status'[o] /= "running"]_vars

\* Runs on one node start in the order they were created.
QueuedStartInOrder ==
  [][\A r \in Runs :
       (status[r] = "queued" /\ status'[r] = "running")
         => \A o \in OnNode(r) : (o < r) => status'[o] /= "queued"]_vars

\* A queued run's context points at every run accepted before it starts, so
\* at the accepted result of the run ahead of it.
QueuedRunSeesRunAhead ==
  [][\A r \in Runs :
       (status[r] = "queued" /\ status'[r] = "running")
         => Accepted(status') \subseteq seen'[r]]_vars

\* No run waits on a node nothing holds: a queued run always has a running run
\* ahead of it, so it is never stuck, including after a restart.
QueuedHasRunAhead ==
  appUp => \A r \in Runs :
    status[r] = "queued" => \E o \in OnNode(r) : status[o] = "running"

\* Reachability, expected to be violated: runs on different nodes run at once.
NeverTwoNodesAtOnce ==
  ~(\E r, o \in Runs : NodeOf(r) /= NodeOf(o) /\ status[r] = "running" /\ status[o] = "running")

\* Every queued run eventually starts, is stopped, or is paused by a restart.
QueuedRunsLeaveTheQueue ==
  \A r \in Runs : (status[r] = "queued") ~> (status[r] /= "queued")

\* Without a restart, a run the user does not stop starts.
QueuedRunsStart ==
  \A r \in Runs : (status[r] = "queued") ~> (status[r] \in {"running", "stopped"} \cup Settled)

\* #722: no paused or interrupted run starts or waits to start until the user
\* resumes it, across any number of restarts. It may still end: the user discards
\* it, or startup records a result the graph accepted.
NoStartWithoutResume ==
  [][\A r \in Runs :
       (status[r] \in Resumable /\ status'[r] \in {"running", "queued", "checked"}) => r \in released']_vars

\* #722: resume keeps same-node order. A run a restart stopped never starts while
\* an earlier run on its node that a restart stopped still waits for the user.
ResumeKeepsOrder ==
  [][\A r \in stoppedByRestart :
       (status[r] /= "running" /\ status'[r] = "running")
         => ~\E o \in OnNode(r) : o < r /\ o \in stoppedByRestart /\ status'[o] \in Resumable]_vars

\* A resumed run starts, or ends, unless another restart stops it again.
ResumedRunsStart ==
  \A r \in Runs : (r \in released /\ status[r] = "queued")
    ~> (status[r] \in {"running"} \cup Settled \cup Resumable)

\* Reachability, expected to be violated: after a restart, a resumed chain runs.
NeverResumes == \A r \in Runs : ~(r \in released /\ status[r] = "running")
=============================================================================
