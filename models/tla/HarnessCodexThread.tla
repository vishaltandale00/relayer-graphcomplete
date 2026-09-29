-------------------------- MODULE HarnessCodexThread --------------------------
(***************************************************************************)
(* codex.basic's persistent root thread (codexThreadId) across serialized  *)
(* root turns: providers and Codex homes, Stop, the per-turn force-stop    *)
(* and force shutdown, a thread saved by an earlier release, and the       *)
(* visible reset notice (#584: native history is never silently dropped).  *)
(*                                                                         *)
(* A Codex thread has a rollout in a home only once a turn/start on it was *)
(* accepted there. thread/resume of a thread without a rollout in the      *)
(* turn's home fails with "no rollout found" (observed on the pinned Codex *)
(* 0.147.0 binary). Provider s (the subscription) has its own home S; two  *)
(* API-key providers k1 and k2 share Codex's default home D, as they do in *)
(* a conversation saved before per-provider homes. In a new conversation   *)
(* each has its own home, like s.                                          *)
(*                                                                         *)
(* Nine constants hold the fixes; each -reverted check turns one off:      *)
(*   CommitAtTurnStart      the thread is saved when turn/start is accepted *)
(*                          (onTurnId), not when thread/start answers.      *)
(*   ThreadRecordsHome      the saved thread records a binding; a turn that *)
(*                          does not match it starts fresh.                 *)
(*   BindToHome             that binding is the Codex home, not the         *)
(*                          provider, so providers sharing a home resume.   *)
(*   RecoverMissingRollout  thread/resume "no rollout found" forgets the    *)
(*                          saved thread and starts a fresh one in the turn.*)
(*   ForceForgets           a force-stop or force shutdown of a root turn   *)
(*                          that sent turn/start forgets the saved thread.  *)
(*   CommitChecksForce      a turn/start accepted after the force is not    *)
(*                          saved (onTurnId checks the force signal).       *)
(*   ForgetOnlyAfterTurnStart  a turn forced before it sent turn/start      *)
(*                          wrote nothing, so the saved thread is kept.     *)
(*   StopForgetsPendingStart  a Stop that kills the app-server while        *)
(*                          turn/start is pending forgets the thread.       *)
(*   ResetsVisible          every forget leaves a notice that the next      *)
(*                          fresh root thread reports.                      *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS AllowSwitch, AllowCancel, LegacyState,
          CommitAtTurnStart, ThreadRecordsHome, BindToHome, RecoverMissingRollout,
          ForceForgets, CommitChecksForce, ForgetOnlyAfterTurnStart,
          StopForgetsPendingStart, ResetsVisible

Turns == 1..3
Providers == {"s", "k1", "k2"}
Homes == {"S", "D"}
HomeOf(p) == IF p = "s" THEN "S" ELSE "D"
Binding(p) == IF BindToHome THEN HomeOf(p) ELSE p   \* what the saved thread records
Threads == 1..4
Legacy == 4                  \* a thread saved by an earlier release, with no provider recorded
Unknown == "unknown"
Active == {"resume", "threadStart", "onThreadId", "turnStart", "awaitTurn", "running"}

VARIABLES
  saved, savedHome,          \* the harness's saved root thread and its binding
  nextT, rollout,            \* Codex: thread ids, and the home holding each rollout
  pc, prov, tthread, forced, sent, cur,
  \* history for the properties
  tainted,                   \* threads a forced turn may have left mid-write
  mustResume, mustHome,      \* the thread the next root turn on mustHome should resume
  notice, hadConversation,   \* a reset notice is pending; a root conversation not yet reported lost
  deadResume, blindResume, resumedKilled, needless, resumedOK, silentReset

vars == <<saved, savedHome, nextT, rollout, pc, prov, tthread, forced, sent, cur,
          tainted, mustResume, mustHome, notice, hadConversation,
          deadResume, blindResume, resumedKilled, needless, resumedOK, silentReset>>
flags == <<deadResume, blindResume, resumedKilled, needless, resumedOK, silentReset>>

home == [t \in Turns |-> HomeOf(prov[t])]

LegacyRollouts == IF LegacyState THEN {"none", "S"} ELSE {"none"}

Init ==
  /\ saved \in IF LegacyState THEN {0, Legacy} ELSE {0}
  /\ savedHome = Unknown
  /\ nextT = 1
  /\ rollout \in {[t \in Threads |-> IF t = Legacy THEN r ELSE "none"] : r \in LegacyRollouts}
  /\ pc = [t \in Turns |-> "idle"]
  /\ prov \in [Turns -> IF AllowSwitch THEN Providers ELSE {"s"}]
  /\ tthread = [t \in Turns |-> 0]
  /\ forced = [t \in Turns |-> FALSE]
  /\ sent = [t \in Turns |-> FALSE]
  /\ cur = 1
  /\ tainted = {}
  /\ mustResume = 0 /\ mustHome = "S"
  /\ notice = FALSE
  /\ hadConversation = (saved # 0)
  /\ deadResume = FALSE /\ blindResume = FALSE /\ resumedKilled = FALSE
  /\ needless = FALSE /\ resumedOK = FALSE /\ silentReset = FALSE

\* The harness drops the saved thread and keeps the reason for the next fresh thread.
Forget ==
  /\ saved' = 0 /\ savedHome' = Unknown
  /\ notice' = (notice \/ ResetsVisible)

\* The turn saves its thread (codex-basic.ts onTurnId), unless it was forced first.
Commit(t) ==
  IF CommitChecksForce /\ forced[t]
    THEN UNCHANGED <<saved, savedHome>>
    ELSE /\ saved' = tthread[t]
         /\ savedHome' = IF ThreadRecordsHome THEN Binding(prov[t]) ELSE Unknown

\* Root turns are serialized by the host's session lock. A thread bound to another home
\* (or, reverted, another provider) is dropped before the turn (codex-basic.ts execute).
\* A turn in another home cannot resume, so it clears what the next turn must resume.
Begin(t) ==
  /\ t = cur /\ pc[t] = "idle"
  /\ LET stale == ThreadRecordsHome /\ saved # 0 /\ savedHome # Unknown /\ savedHome # Binding(prov[t])
         kept == IF stale THEN 0 ELSE saved
         owed == mustResume # 0 /\ mustHome = home[t]
     IN /\ IF stale THEN Forget ELSE UNCHANGED <<saved, savedHome, notice>>
        /\ pc' = [pc EXCEPT ![t] = IF kept # 0 THEN "resume" ELSE "threadStart"]
        /\ tthread' = [tthread EXCEPT ![t] = kept]
        /\ needless' = (needless \/ (owed /\ kept # mustResume))
        /\ resumedKilled' = (resumedKilled \/ (kept # 0 /\ kept \in tainted))
        /\ mustResume' = IF owed THEN mustResume ELSE 0
  /\ UNCHANGED <<nextT, rollout, prov, forced, sent, cur, tainted, mustHome, hadConversation,
                 deadResume, blindResume, resumedOK, silentReset>>

\* codex-app-server.ts run(): thread/resume of savedThreadId.
Resume(t) ==
  /\ pc[t] = "resume" /\ ~forced[t]
  /\ IF rollout[tthread[t]] = home[t] THEN
       /\ pc' = [pc EXCEPT ![t] = "onThreadId"]
       /\ resumedOK' = TRUE
       /\ UNCHANGED <<saved, savedHome, notice, deadResume, blindResume>>
     ELSE
       /\ blindResume' = (blindResume \/ tthread[t] # Legacy)
       /\ UNCHANGED resumedOK
       /\ IF RecoverMissingRollout THEN
            \* onSavedThreadUnavailable, then thread/start in the same process.
            /\ IF saved = tthread[t] THEN Forget ELSE UNCHANGED <<saved, savedHome, notice>>
            /\ pc' = [pc EXCEPT ![t] = "threadStart"]
            /\ UNCHANGED deadResume
          ELSE
            /\ pc' = [pc EXCEPT ![t] = "failed"]
            /\ deadResume' = TRUE
            /\ UNCHANGED <<saved, savedHome, notice>>
  /\ UNCHANGED <<nextT, rollout, prov, tthread, forced, sent, cur, tainted, mustResume,
                 mustHome, hadConversation, resumedKilled, needless, silentReset>>

\* A fresh thread after an earlier root conversation reports the pending reset notice.
ThreadStart(t) ==
  /\ pc[t] = "threadStart" /\ ~forced[t] /\ nextT \in 1..3
  /\ tthread' = [tthread EXCEPT ![t] = nextT]
  /\ nextT' = nextT + 1
  /\ pc' = [pc EXCEPT ![t] = "onThreadId"]
  /\ silentReset' = (silentReset \/ (hadConversation /\ ~notice))
  /\ notice' = FALSE
  \* The loss is reported once; a later conversation starts at its own turn/start.
  /\ hadConversation' = FALSE
  /\ UNCHANGED <<saved, savedHome, rollout, prov, forced, sent, cur, tainted, mustResume,
                 mustHome, deadResume, blindResume, resumedKilled, needless, resumedOK>>

\* Before the fix, onThreadId saved the thread before turn/start (and before Stop was checked).
OnThreadId(t) ==
  /\ pc[t] = "onThreadId" /\ ~forced[t]
  /\ IF CommitAtTurnStart THEN UNCHANGED <<saved, savedHome>> ELSE Commit(t)
  /\ pc' = [pc EXCEPT ![t] = "turnStart"]
  /\ UNCHANGED <<nextT, rollout, prov, tthread, forced, sent, cur, tainted, mustResume,
                 mustHome, notice, hadConversation, flags>>

\* onTurnStarting: from here on, this turn may write the thread's rollout.
SendTurnStart(t) ==
  /\ pc[t] = "turnStart" /\ ~forced[t]
  /\ sent' = [sent EXCEPT ![t] = TRUE]
  /\ hadConversation' = TRUE
  /\ pc' = [pc EXCEPT ![t] = "awaitTurn"]
  /\ UNCHANGED <<saved, savedHome, nextT, rollout, prov, tthread, forced, cur, tainted,
                 mustResume, mustHome, notice, flags>>

\* turn/start accepted: the rollout now exists in this turn's home, and onTurnId saves it.
\* The answer may already be in flight when the turn is forced.
TurnStart(t) ==
  /\ pc[t] = "awaitTurn"
  /\ rollout' = [rollout EXCEPT ![tthread[t]] = IF @ = "none" THEN home[t] ELSE @]
  /\ IF CommitAtTurnStart THEN Commit(t) ELSE UNCHANGED <<saved, savedHome>>
  /\ pc' = [pc EXCEPT ![t] = "running"]
  /\ UNCHANGED <<nextT, prov, tthread, forced, sent, cur, tainted, mustResume, mustHome,
                 notice, hadConversation, flags>>

\* A normal finish: the next root turn on this home should resume this thread.
Finish(t) ==
  /\ pc[t] = "running" /\ ~forced[t]
  /\ pc' = [pc EXCEPT ![t] = "done"]
  /\ mustResume' = tthread[t] /\ mustHome' = home[t]
  /\ UNCHANGED <<saved, savedHome, nextT, rollout, prov, tthread, forced, sent, cur, tainted,
                 notice, hadConversation, flags>>

\* Stop. Before turn attachment the app-server is killed. With turn/start pending it may
\* have left the thread mid-write, as a force does. After attachment the turn is
\* interrupted, and its thread stays resumable.
Cancel(t) ==
  /\ AllowCancel /\ ~forced[t] /\ pc[t] \in Active
  /\ pc' = [pc EXCEPT ![t] = "failed"]
  /\ IF pc[t] = "running"
       THEN /\ mustResume' = tthread[t] /\ mustHome' = home[t]
            /\ UNCHANGED <<saved, savedHome, notice, tainted>>
       ELSE IF pc[t] = "awaitTurn"
       THEN /\ tainted' = tainted \cup {tthread[t]}
            /\ mustResume' = 0 /\ UNCHANGED mustHome
            /\ IF StopForgetsPendingStart THEN Forget ELSE UNCHANGED <<saved, savedHome, notice>>
       ELSE UNCHANGED <<mustResume, mustHome, saved, savedHome, notice, tainted>>
  /\ UNCHANGED <<nextT, rollout, prov, tthread, forced, sent, cur, hadConversation, flags>>

\* Per-turn force-stop or force shutdown. The kill lands later (Kill), so an answer already
\* in flight can still arrive. A turn that sent turn/start may have left its thread mid-write.
Force(t) ==
  /\ pc[t] \in Active /\ ~forced[t]
  /\ forced' = [forced EXCEPT ![t] = TRUE]
  /\ IF ForceForgets /\ (sent[t] \/ ~ForgetOnlyAfterTurnStart)
       THEN Forget
       ELSE UNCHANGED <<saved, savedHome, notice>>
  /\ tainted' = IF sent[t] THEN tainted \cup {tthread[t]} ELSE tainted
  /\ mustResume' = IF sent[t] THEN 0 ELSE mustResume
  /\ UNCHANGED <<nextT, rollout, pc, prov, tthread, sent, cur, mustHome, hadConversation, flags>>

Kill(t) ==
  /\ forced[t] /\ pc[t] \in Active
  /\ pc' = [pc EXCEPT ![t] = "failed"]
  /\ UNCHANGED <<saved, savedHome, nextT, rollout, prov, tthread, forced, sent, cur, tainted,
                 mustResume, mustHome, notice, hadConversation, flags>>

\* The host run ends and persists the state; a restart restores it unchanged.
End(t) ==
  /\ t = cur /\ pc[t] \in {"done", "failed"} /\ cur < 3
  /\ cur' = cur + 1
  /\ UNCHANGED <<saved, savedHome, nextT, rollout, pc, prov, tthread, forced, sent, tainted,
                 mustResume, mustHome, notice, hadConversation, flags>>

Next == \E t \in Turns : Begin(t) \/ Resume(t) \/ ThreadStart(t) \/ OnThreadId(t)
                         \/ SendTurnStart(t) \/ TurnStart(t) \/ Finish(t) \/ Cancel(t)
                         \/ Force(t) \/ Kill(t) \/ End(t)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ saved \in Threads \cup {0}
  /\ savedHome \in Homes \cup Providers \cup {Unknown}
  /\ mustResume \in Threads \cup {0}
  /\ cur \in Turns

\* PRD architecture: a Complete call "remains semantically valid even when the provider
\* starts a fresh session". A root turn never fails because the harness resumes a thread
\* Codex cannot resume.
NoDeadResume == ~deadResume

\* CODE: the harness offers for resume only a thread with a rollout in the turn's home,
\* except a thread saved by an earlier release, whose provider it cannot know.
ResumeOnlyMaterialized == ~blindResume

\* PRD, Provider execution access: a root conversation killed mid-write, by a force or by a
\* Stop while turn/start was pending, is not resumed.
NoKilledResume == ~resumedKilled

\* #584: native history is kept whenever it can be resumed. After a root turn in a home
\* finishes, or is stopped once running, the next root turn in that home resumes its thread,
\* whichever provider it uses, unless a later conversation was killed.
NoNeedlessForget == ~needless

\* #584: a root turn that starts a fresh thread after an earlier root conversation reports
\* a reset notice.
NoSilentReset == ~silentReset

\* Witness, expected to be violated: a real resume is reachable, so the properties above
\* are not vacuous.
NeverResumes == ~resumedOK
================================================================================
