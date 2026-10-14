---------------------------- MODULE RunCapacity ----------------------------
(***************************************************************************)
(* The app's internal limit on human-started runs (#720, PRD 12.2 PAR-011 *)
(* to PAR-014), composed with the per-node run queue (#718). At most Limit *)
(* human-started runs execute at once. Above it a run waits as `queued`    *)
(* for capacity, and waiting runs start first in, first out as slots free. *)
(* A run on a busy node waits for its node first; once it holds its node,  *)
(* it waits for capacity. A child an agent invokes never asks for a slot.  *)
(*                                                                         *)
(*   RC  = crates/relayer-app-server/src/api/run_capacity.rs               *)
(*   NQ  = crates/relayer-app-server/src/api/node_runs.rs                  *)
(*   THR = crates/relayer-app-server/src/api/threads.rs                    *)
(*   SRC = crates/relayer-app-server/src/storage/sqlite/run_capacity.rs    *)
(*   STP = crates/relayer-app-server/src/storage/sqlite/stops.rs           *)
(*   APP = crates/relayer-app-server/src/app_server.rs                     *)
(*                                                                         *)
(* Human runs 1..SameNode are invoked on node 1, in that order. The other  *)
(* human runs each have a node of their own, like a message turn or an     *)
(* invoke on another node. Children follow the human runs.                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  Limit,              \* HUMAN_RUN_CAPACITY (RC); 16 in the app, small here
  SameNode,           \* human runs started on node 1
  OwnNode,            \* human runs that each have their own node
  Children,           \* runs an agent invokes
  MaxRestarts,
  AtomicAdmission,    \* fix: checking for a free slot and taking it, or
                      \* queueing, are one step under the lock (RC admit)
  ReleaseHandsSlot,   \* fix: a released slot passes to a waiting run (RC release)
  Fifo,               \* decision (#720): the slot passes to the oldest waiting run
  ChildrenUncounted,  \* decision 5 (#716): a child never asks for a slot
  StartupInterruptsWaits \* fix: startup ends every wait for capacity (SRC
                      \* interrupt_capacity_waits)

Humans == 1..(SameNode + OwnNode)
Kids == (SameNode + OwnNode + 1)..(SameNode + OwnNode + Children)
Runs == Humans \cup Kids
NodeOf(r) == IF r <= SameNode THEN 1 ELSE r + 1
Nodes == {NodeOf(r) : r \in Humans}

\* unsent: not started yet. nodeQueued: behind a run on its node. holding: it
\* holds its node and asks for a slot next (THR start_held_action_interaction).
\* checked: admission saw a slot free but has not taken it (only without
\* AtomicAdmission). capQueued: queued for capacity, holding its node.
\* interrupted: a restart ended it; the user starts it again.
Statuses == {"unsent", "nodeQueued", "holding", "checked", "capQueued", "running",
             "accepted", "failed", "stopped", "interrupted"}
Settled == {"accepted", "failed", "stopped"}

VARIABLES
  status,     \* run -> Statuses
  holder,     \* node -> the run holding it, or 0. Live state.
  slots,      \* the runs holding a capacity slot. Live state.
  waitq,      \* the runs waiting for a slot, in the order they began. Live state.
  waitedNode, \* runs that ever waited behind their node
  appUp,
  restarts

vars == <<status, holder, slots, waitq, waitedNode, appUp, restarts>>

TypeOK ==
  /\ status \in [Runs -> Statuses]
  /\ holder \in [Nodes -> Humans \cup {0}]
  /\ slots \subseteq Runs
  /\ waitq \in Seq(Runs)
  /\ waitedNode \subseteq Humans
  /\ appUp \in BOOLEAN
  /\ restarts \in 0..MaxRestarts

Init ==
  /\ status = [r \in Runs |-> "unsent"]
  /\ holder = [n \in Nodes |-> 0]
  /\ slots = {}
  /\ waitq = <<>>
  /\ waitedNode = {}
  /\ appUp = TRUE
  /\ restarts = 0

InQueue(r) == \E i \in 1..Len(waitq) : waitq[i] = r
Without(q, r) == SelectSeq(q, LAMBDA x : x /= r)
SlotFree == Cardinality(slots) < Limit /\ waitq = <<>>

\* RC admit: a run takes a free slot, or waits for one, holding its node.
AskForSlot(r) ==
  IF SlotFree
  THEN /\ status' = [status EXCEPT ![r] = "running"]
       /\ slots' = slots \cup {r}
       /\ UNCHANGED waitq
  ELSE /\ status' = [status EXCEPT ![r] = "capQueued"]   \* SRC queue_run_for_capacity
       /\ waitq' = Append(waitq, r)
       /\ UNCHANGED slots

-----------------------------------------------------------------------------
(* A person starts a run, or starts an interrupted one again (THR           *)
(* start_interaction, claim_and_start_action_interaction, retry).           *)

\* NQ admit, then RC admit. A run on a busy node waits behind it first.
Send(r) ==
  /\ appUp /\ r \in Humans /\ status[r] \in {"unsent", "interrupted"}
  /\ IF holder[NodeOf(r)] = 0
     THEN /\ holder' = [holder EXCEPT ![NodeOf(r)] = r]
          /\ status' = [status EXCEPT ![r] = "holding"]
          /\ UNCHANGED waitedNode
     ELSE /\ status' = [status EXCEPT ![r] = "nodeQueued"]
          /\ waitedNode' = waitedNode \cup {r}
          /\ UNCHANGED holder
  /\ UNCHANGED <<slots, waitq, appUp, restarts>>

\* With the lock, checking and taking a slot, or queueing, are one step.
\* Without it a run can pass the check before another takes the last slot.
Admit(r) ==
  /\ appUp /\ status[r] = "holding"
  /\ IF AtomicAdmission
     THEN AskForSlot(r)
     ELSE /\ IF SlotFree
             THEN status' = [status EXCEPT ![r] = "checked"]
             ELSE status' = [status EXCEPT ![r] = "capQueued"]
          /\ waitq' = IF SlotFree THEN waitq ELSE Append(waitq, r)
          /\ UNCHANGED slots
  /\ UNCHANGED <<holder, waitedNode, appUp, restarts>>

Take(r) ==
  /\ appUp /\ status[r] = "checked"
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ slots' = slots \cup {r}
  /\ UNCHANGED <<holder, waitq, waitedNode, appUp, restarts>>

\* An agent invokes a child (THR complete_prepared_child). It never asks for a
\* slot; reverted, it would wait like a human-started run.
LaunchChild(c) ==
  /\ appUp /\ c \in Kids /\ status[c] = "unsent"
  /\ IF ChildrenUncounted
     THEN /\ status' = [status EXCEPT ![c] = "running"]
          /\ UNCHANGED <<slots, waitq>>
     ELSE AskForSlot(c)
  /\ UNCHANGED <<holder, waitedNode, appUp, restarts>>

-----------------------------------------------------------------------------
(* A run settles. Its slot and its node are released in separate steps, as  *)
(* separate tasks release them in the code (THR release_run_capacity,       *)
(* release_node_run). A settled run keeps both until then.                  *)

Settle(r, outcome) ==
  /\ appUp /\ status[r] = "running"
  /\ status' = [status EXCEPT ![r] = outcome]
  /\ UNCHANGED <<holder, slots, waitq, waitedNode, appUp, restarts>>

Oldest(q) == q[1]

\* RC release: the slot passes to the oldest waiting run, which starts. A run a
\* Stop removed has already left the queue (RC forget).
ReleaseSlot(r) ==
  /\ appUp /\ r \in slots /\ status[r] \in Settled
  /\ IF ReleaseHandsSlot /\ waitq /= <<>>
     THEN \E next \in {waitq[i] : i \in 1..Len(waitq)} :
            /\ (Fifo => next = Oldest(waitq))
            /\ status' = [status EXCEPT ![next] = "running"]   \* SRC claim_capacity_run
            /\ slots' = (slots \ {r}) \cup {next}
            /\ waitq' = Without(waitq, next)
     ELSE /\ slots' = slots \ {r}
          /\ UNCHANGED <<status, waitq>>
  /\ UNCHANGED <<holder, waitedNode, appUp, restarts>>

\* NQ release: the node passes to the oldest run behind it, which then asks
\* for a slot. A run removed while it waited for capacity frees its node too.
OldestOnNode(n, st) ==
  LET waiting == {o \in Humans : NodeOf(o) = n /\ st[o] = "nodeQueued"}
  IN IF waiting = {} THEN 0 ELSE CHOOSE o \in waiting : \A w \in waiting : o <= w

ReleaseNode(r) ==
  /\ appUp /\ r \in Humans /\ holder[NodeOf(r)] = r /\ status[r] \in Settled
  /\ LET next == OldestOnNode(NodeOf(r), status)
     IN /\ holder' = [holder EXCEPT ![NodeOf(r)] = next]
        /\ status' = IF next = 0 THEN status ELSE [status EXCEPT ![next] = "holding"]
  /\ UNCHANGED <<slots, waitq, waitedNode, appUp, restarts>>

\* STP request_interaction_stop and RC forget: Remove takes a run out of its
\* queue. It never starts, and its text is kept.
Remove(r) ==
  /\ appUp /\ status[r] \in {"nodeQueued", "capQueued"}
  /\ status' = [status EXCEPT ![r] = "stopped"]
  /\ waitq' = Without(waitq, r)
  /\ UNCHANGED <<holder, slots, waitedNode, appUp, restarts>>

-----------------------------------------------------------------------------
(* Crash and startup. A crash loses every live slot, hold and wait. Startup *)
(* interrupts executing and queued runs; nothing starts on its own.         *)

Crash ==
  /\ appUp /\ restarts < MaxRestarts
  /\ appUp' = FALSE
  /\ holder' = [n \in Nodes |-> 0]
  /\ slots' = {}
  /\ waitq' = <<>>
  /\ UNCHANGED <<status, waitedNode, restarts>>

Startup ==
  /\ ~appUp
  /\ status' = [r \in Runs |->
       IF status[r] \in {"running", "checked", "holding", "nodeQueued"}
          \/ (StartupInterruptsWaits /\ status[r] = "capQueued")
       THEN "interrupted" ELSE status[r]]
  /\ appUp' = TRUE /\ restarts' = restarts + 1
  /\ UNCHANGED <<holder, slots, waitq, waitedNode>>

-----------------------------------------------------------------------------
Next ==
  \/ \E r \in Runs : Send(r) \/ Admit(r) \/ Take(r) \/ LaunchChild(r) \/ Remove(r)
                     \/ ReleaseSlot(r) \/ ReleaseNode(r)
  \/ \E r \in Runs, outcome \in Settled : Settle(r, outcome)
  \/ Crash \/ Startup

Spec == Init /\ [][Next]_vars

\* Code steps run while enabled, and a provider run eventually ends.
FairSpec ==
  /\ Spec
  /\ \A r \in Runs : WF_vars(Admit(r)) /\ WF_vars(Take(r))
  /\ \A r \in Runs : WF_vars(ReleaseSlot(r)) /\ WF_vars(ReleaseNode(r))
  /\ \A r \in Runs : WF_vars(\E outcome \in Settled : Settle(r, outcome))
  /\ WF_vars(Startup)

-----------------------------------------------------------------------------
(* Promises.                                                               *)

RunningHumans == {r \in Humans : status[r] = "running"}

\* PRD 12.2 (#720): executing human-started runs never exceed the limit.
WithinLimit == Cardinality(RunningHumans) <= Limit

\* Waiting runs start first in, first out. Runs join the wait only at its end
\* (AskForSlot), so a run that starts from the wait is the one that has waited
\* longest: none still waiting began before it.
StartsInOrder ==
  [][\A r \in Runs :
       (status[r] = "capQueued" /\ status'[r] = "running")
         => waitq /= <<>> /\ waitq[1] = r]_vars

\* No run waits while a slot is idle, so a waiting run is never stuck,
\* including after a restart.
NoIdleSlotWhileWaiting ==
  appUp => ((\E r \in Runs : status[r] = "capQueued") => Cardinality(slots) = Limit)

\* Every run waiting for capacity is in the live wait that release serves.
WaitIsLive ==
  appUp => \A r \in Runs : status[r] = "capQueued" => InQueue(r)

\* The node queue still holds: two runs on one node never run at once.
OneRunPerNode ==
  \A r, o \in Humans : (r /= o /\ NodeOf(r) = NodeOf(o))
    => ~(status[r] = "running" /\ status[o] = "running")

\* Decision 5 (#716): a child an agent invokes never waits for capacity.
ChildrenNeverWait == \A c \in Kids : status[c] /= "capQueued"

\* Reachability, expected to be violated: a child runs while human-started runs
\* fill every slot.
ChildNeverBesideFullCapacity ==
  ~(Cardinality(RunningHumans) = Limit /\ \E c \in Kids : status[c] = "running")

\* Reachability, expected to be violated: one run waits behind its node, then
\* for capacity. Each wait shows its own reason.
NeverWaitsForBoth == \A r \in waitedNode : status[r] /= "capQueued"

\* Without a restart, every run waiting for capacity that is not removed starts.
WaitingRunsStart ==
  \A r \in Runs : (status[r] = "capQueued") ~> (status[r] \in {"running"} \cup Settled)

\* Across a restart, every run waiting for capacity leaves the wait.
WaitingRunsLeaveTheWait ==
  \A r \in Runs : (status[r] = "capQueued") ~> (status[r] /= "capQueued")
=============================================================================
