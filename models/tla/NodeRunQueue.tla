---------------------------- MODULE NodeRunQueue ----------------------------
(***************************************************************************)
(* Runs a user starts on nodes (#718, PRD 12.2 PAR-007 to PAR-010).        *)
(* Runs on different nodes run at once. On one node they run in order:    *)
(* while a run holds its node, a new one waits as `queued`, and the next   *)
(* queued run starts when the run ahead settles, whatever its outcome. A   *)
(* queued run reads the thread when it starts, and a Stop ends it before   *)
(* it starts. A restart never leaves a run queued behind a run that no     *)
(* longer exists.                                                          *)
(*                                                                         *)
(*   NQ  = crates/relayer-app-server/src/api/node_runs.rs                  *)
(*   THR = crates/relayer-app-server/src/api/threads.rs                    *)
(*   NR  = crates/relayer-app-server/src/storage/sqlite/node_runs.rs       *)
(*   STP = crates/relayer-app-server/src/storage/sqlite/stops.rs           *)
(*   AI  = crates/relayer-app-server/src/storage/sqlite/action_invocations.rs *)
(*   INT = crates/relayer-app-server/src/storage/sqlite/interactions.rs    *)
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
  StartupInterruptsQueued \* fix: startup ends the wait of a queued run (AI
                      \* recover_interrupted_action_invocations)

Runs == 1..(SameNode + OtherNode)
NodeOf(r) == IF r <= SameNode THEN 1 ELSE 2
Nodes == {1, 2}

\* unsent: not sent yet. checked: admission saw the node free but has not taken
\* it (only without AtomicAdmission). interrupted: a restart ended it before it
\* settled; invoking its action again resumes it.
Statuses == {"unsent", "checked", "queued", "running", "accepted", "failed",
             "stopped", "interrupted"}
Settled == {"accepted", "failed", "stopped"}

VARIABLES
  status,     \* run -> Statuses
  holder,     \* node -> the run holding it, or 0. Live state: lost on a crash.
  seen,       \* run -> the accepted runs its context points at
  appUp,
  restarts

vars == <<status, holder, seen, appUp, restarts>>

TypeOK ==
  /\ status \in [Runs -> Statuses]
  /\ holder \in [Nodes -> Runs \cup {0}]
  /\ seen \in [Runs -> SUBSET Runs]
  /\ appUp \in BOOLEAN
  /\ restarts \in 0..MaxRestarts

Init ==
  /\ status = [r \in Runs |-> "unsent"]
  /\ holder = [n \in Nodes |-> 0]
  /\ seen = [r \in Runs |-> {}]
  /\ appUp = TRUE
  /\ restarts = 0

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
(* The user sends a run, or invokes an interrupted run's action again       *)
(* (THR finish_action_handoff -> claim_and_start_action_interaction).        *)

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
  /\ UNCHANGED <<appUp, restarts>>

Take(r) ==
  /\ appUp /\ status[r] = "checked"
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ holder' = [holder EXCEPT ![NodeOf(r)] = r]
  /\ seen' = IF ContextAtStart THEN [seen EXCEPT ![r] = Accepted(status)] ELSE seen
  /\ UNCHANGED <<appUp, restarts>>

Resume(r) ==
  /\ appUp /\ status[r] = "interrupted"
  /\ Admit(r)
  /\ UNCHANGED <<appUp, restarts>>

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
  /\ UNCHANGED <<appUp, restarts>>

\* STP request_interaction_stop: a queued run stops at once, never starting.
StopQueued(r) ==
  /\ appUp /\ status[r] = "queued"
  /\ status' = [status EXCEPT ![r] = "stopped"]
  /\ UNCHANGED <<holder, seen, appUp, restarts>>

-----------------------------------------------------------------------------
(* Crash and startup. Startup interrupts executing runs, and queued ones    *)
(* with them; nothing starts on its own (#722 replaces this with paused).    *)

Crash ==
  /\ appUp /\ restarts < MaxRestarts
  /\ appUp' = FALSE
  /\ holder' = [n \in Nodes |-> 0]
  /\ UNCHANGED <<status, seen, restarts>>

Startup ==
  /\ ~appUp
  /\ status' = [r \in Runs |->
       IF status[r] \in {"running", "checked"}
          \/ (StartupInterruptsQueued /\ status[r] = "queued")
       THEN "interrupted" ELSE status[r]]
  /\ appUp' = TRUE /\ restarts' = restarts + 1
  /\ UNCHANGED <<holder, seen>>

-----------------------------------------------------------------------------
Next ==
  \/ \E r \in Runs : Send(r) \/ Take(r) \/ Resume(r) \/ StopQueued(r)
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

\* Every queued run eventually starts, is stopped, or is interrupted by a restart.
QueuedRunsLeaveTheQueue ==
  \A r \in Runs : (status[r] = "queued") ~> (status[r] /= "queued")

\* Without a restart, a run the user does not stop starts.
QueuedRunsStart ==
  \A r \in Runs : (status[r] = "queued") ~> (status[r] \in {"running", "stopped"} \cup Settled)
=============================================================================
