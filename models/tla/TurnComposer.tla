---------------------------- MODULE TurnComposer ----------------------------
(***************************************************************************)
(* The follow-up composer of the Product workspace: typing, Send, the     *)
(* follow-up POST, the new turn arriving, and settlement of the submitted *)
(* draft, while the user switches threads and the workspace re-renders.   *)
(*                                                                         *)
(* Source of truth (every action cites the code it abstracts):            *)
(*   WS = desktop/renderer/src/product-workspace/workspace.js              *)
(*   CS = desktop/renderer/src/product-workspace/composer-submission.js    *)
(*   TH = desktop/renderer/src/threads.js                                  *)
(*   CD = desktop/renderer/src/composer-drafts.js                          *)
(*                                                                         *)
(* The renderer is single-threaded. Each action is one task: a user event *)
(* or the continuation of one await. Code between two awaits is atomic.   *)
(*                                                                         *)
(* A composer draft is scoped to (thread, latest turn) (WS:1126). Text is  *)
(* abstracted to an identity: each keystroke burst makes a fresh value,   *)
(* and 0 is the empty prompt. Context annotations, input attachments,     *)
(* restored retry drafts, the model picker, and the unconfirmed-draft     *)
(* warning are not modeled.                                                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Threads,          \* thread ids
  MaxTurns,         \* bound on turns per thread
  MaxText,          \* bound on distinct typed values
  MaxRev,           \* bound on composerPromptRevision
  BackgroundRenders, \* renderThread() runs for reasons unrelated to the send
                    \* (window focus refreshes the environment, polling, SSE)
  CarryUnsentDraft, \* TRUE since #512: entering a newer turn's empty scope
                    \* moves unsent text from the newest older scope of the
                    \* thread, unless it is the submission in flight; a
                    \* failed send restores its stranded text. Before, the
                    \* new scope started empty and the text was stranded
  StableScopeRevision, \* TRUE since #513: re-entering a scope keeps its
                    \* revision when its text is unchanged and otherwise
                    \* takes one above any it had. Before, it took
                    \* currentPromptRevision + 1, which could repeat or
                    \* change without the text changing
  OtherTurns,       \* a turn created elsewhere in the thread (an authored
                    \* invoke, another window) can arrive
  HoldFromClick,    \* TRUE since review of #512: the submission is held from
                    \* the click, through Send's input reconciliation, and a
                    \* Send that ends without posting hands back stranded
                    \* text. Before, it was held only once the POST began
  HandBackUncertain, \* TRUE since review of #512: a send lost to a network or
                    \* server error hands back text a newer, unrelated turn
                    \* left in its scope, unless its own turn already
                    \* arrived. Before, the text stayed stranded there
  RetireSuperseded, \* TRUE since review of #512: stranded text that text typed
                    \* since keeps out of the prompt is retired from its
                    \* scope (SCP-021). Before, it stayed and could be carried
                    \* forward later
  HoldUncertain,    \* TRUE since review of #512: a send whose failure leaves
                    \* it unknown whether it was sent is held once its turn
                    \* arrives (SCP-019). Before, its text could be carried
                    \* into the turn it created
  MessagesInParallel \* TRUE since #719: thread messages run in parallel. A run
                    \* never disables the prompt, and the server admits a
                    \* message while another runs. Before, the prompt was
                    \* disabled while the latest turn ran, and the server
                    \* refused a second message with interaction_in_progress

None == "none"
Null == MaxText + 1   \* composer-drafts has no value for the key
NoDraft == [text |-> Null, rev |-> 0]
Scopes == Threads \X (1..MaxTurns)
Texts == 0..MaxText
Phases == {"idle", "reconcile", "post", "posted", "refresh", "settle"}

VARIABLES
  \* --- Product state as the renderer sees it (appState) ---
  view,         \* viewState.currentThreadId
  latest,       \* thread -> index of its latest turn
  running,      \* thread -> its latest turn's completion is pending
  pendingTurn,  \* thread -> the server holds a follow-up turn the renderer
                \* has not loaded yet
  \* --- composer (WS:2420-2422, #threadPrompt) ---
  active,       \* composerDraftScopeState.activeScopeKey
  drafts,       \* composerDraftScopeState.drafts: scope -> [text, rev]
  text,         \* prompt.value
  rev,          \* composerPromptRevision
  disabled,     \* prompt.disabled
  persisted,    \* CD threadFollowups: scope -> text, or Null
  \* --- send attempts (WS:2403-2404) ---
  pc,           \* thread -> phase of its in-flight send (inFlightSendThreads)
  owner,        \* sendAttempt?.threadId, or None
  intent,       \* thread -> [text, rev, scope] captured when Send was clicked
  held,         \* sends lost to an error: [scope, rev, landedAt, text], for sends that
                \* may have been sent; landedAt is the turn the send created
                \* (the renderer recognizes it by its text), or 0
  \* --- ghosts ---
  fresh,        \* last text identity handed out
  sent,         \* texts a successful follow-up POST carried
  unsent,       \* thread -> the user's latest text there, until it is sent
  cleared,      \* the text the last settlement removed from the prompt, or 0
  uncertainAt,  \* [text, scope] of sends that may have been sent
  superseded    \* stranded texts the user replaced by typing newer text

vars == <<view, latest, running, pendingTurn, active, drafts, text, rev, disabled,
          persisted, pc, owner, intent, fresh, sent, unsent, cleared, held, uncertainAt,
          superseded>>
productVars == <<latest, running, pendingTurn>>
composerVars == <<active, drafts, text, rev, disabled, persisted>>
ghostVars == <<fresh, sent, unsent, cleared>>
holdVars == <<held, uncertainAt, superseded>>

Max(a, b) == IF a >= b THEN a ELSE b
Scope(t) == <<t, latest[t]>>

-----------------------------------------------------------------------------
(* transitionComposerDraftScope (WS:1134-1201) with restoredDraft = null   *)
(* and persistedDraftText = threadFollowupDraft(nextScope) (WS:3902-3913). *)
(* Returns the next [drafts, text, rev].                                   *)
EnterScope(next) ==
  LET stored == persisted[next] IN
  IF active = next THEN
    LET changed == stored # Null /\ stored # text
        nt == IF changed THEN stored ELSE text
        nr == IF changed THEN rev + 1 ELSE rev
    IN [drafts |-> [drafts EXCEPT ![next] = [text |-> nt, rev |-> nr]],
        text |-> nt, rev |-> nr, carried |-> FALSE, prior |-> next, retired |-> FALSE]
  ELSE
    LET saved == [drafts EXCEPT ![active] = [text |-> text, rev |-> rev]]
        \* The newest older scope of this thread that holds text.
        older == {k \in 1..(next[2] - 1) :
                    saved[<<next[1], k>>] # NoDraft /\ saved[<<next[1], k>>].text # 0}
        prior == IF older = {} THEN next
                 ELSE <<next[1], CHOOSE k \in older : \A j \in older : j <= k>>
        \* The prior turn's draft is still the in-flight submission,
        \* unchanged since Send; its settlement will clear it. Or it is a
        \* send that may have been sent.
        inFlight == IF HoldFromClick THEN pc[next[1]] # "idle"
                    ELSE pc[next[1]] \notin {"idle", "reconcile"}
        \* The renderer recognizes a sent draft by its text in a later turn.
        landed == HoldUncertain /\ saved[prior] # NoDraft
                  /\ \E h \in held : h.text = saved[prior].text /\ h.landedAt # 0
                                   /\ prior[2] < h.landedAt /\ next[2] >= h.landedAt
        settling == inFlight /\ intent[next[1]].scope = prior
                    /\ saved[prior].rev = intent[next[1]].rev
        submitting == settling \/ landed
        \* A draft its landed turn shows was sent is deleted (SCP-016); the
        \* submission in flight is left to its settlement.
        retired == landed /\ ~settling /\ prior # next
        carried == CarryUnsentDraft /\ older # {} /\ ~submitting
        base == IF StableScopeRevision /\ saved[next] # NoDraft
                THEN Max(saved[next].rev, rev) ELSE rev
        unchanged == StableScopeRevision /\ saved[next] # NoDraft
                     /\ saved[next].text = stored
        empty == stored = Null /\ (saved[next] = NoDraft \/ saved[next].text = 0)
        entered ==
          IF stored # Null /\ unchanged THEN saved
          ELSE IF stored # Null
          THEN [saved EXCEPT ![next] = [text |-> stored, rev |-> base + 1]]
          ELSE IF empty /\ carried
          THEN [saved EXCEPT ![next] = [text |-> saved[prior].text, rev |-> base + 1],
                             ![prior] = NoDraft]
          ELSE IF saved[next] = NoDraft
          THEN [saved EXCEPT ![next] = [text |-> 0, rev |-> rev + 1]]
          ELSE saved
        final == IF retired THEN [entered EXCEPT ![prior] = NoDraft] ELSE entered
    IN [drafts |-> final, text |-> final[next].text, rev |-> final[next].rev,
        carried |-> stored = Null /\ empty /\ carried, prior |-> prior, retired |-> retired]

\* render() for thread t (WS:3749-3938): the scope transition, then
\* renderInteractionState sets prompt.disabled. Under MessagesInParallel only
\* a workspace that cannot compose disables it, so a run never does; before,
\* it followed the latest turn's status. Under CarryUnsentDraft, a carried
\* draft moves: it is persisted under its new scope and removed from the old
\* one.
EnterScopeEffect(next, isRunning) ==
  LET e == EnterScope(next) IN
  /\ drafts' = e.drafts
  /\ text' = e.text
  /\ rev' = e.rev
  /\ active' = next
  /\ disabled' = (isRunning /\ ~MessagesInParallel)
  /\ persisted' = IF e.carried
                  THEN [persisted EXCEPT ![next] = e.text, ![e.prior] = Null]
                  ELSE IF e.retired THEN [persisted EXCEPT ![e.prior] = Null]
                  ELSE persisted

Render(t, isRunning) == EnterScopeEffect(Scope(t), isRunning)

\* The scope's draft is a send that may have been sent; it is not handed
\* back (SCP-019).
\* The text thread t's composer would show, while another thread is shown:
\* its newest scope's persisted draft, else the draft saved when it was left.
AwayText(t) ==
  IF persisted[Scope(t)] # Null THEN persisted[Scope(t)]
  ELSE IF drafts[Scope(t)] # NoDraft THEN drafts[Scope(t)].text ELSE 0

Uncertain(scope) ==
  HoldUncertain /\ drafts[scope] # NoDraft
  /\ \E h \in held : h.text = drafts[scope].text /\ h.landedAt # 0
                   /\ scope[2] < h.landedAt /\ latest[scope[1]] >= h.landedAt

Init ==
  /\ view \in Threads
  /\ latest = [t \in Threads |-> 1]
  /\ running = [t \in Threads |-> FALSE]
  /\ pendingTurn = [t \in Threads |-> FALSE]
  /\ active = <<view, 1>>
  /\ drafts = [s \in Scopes |-> IF s = <<view, 1>> THEN [text |-> 0, rev |-> 1]
                                ELSE NoDraft]
  /\ text = 0 /\ rev = 1 /\ disabled = FALSE
  /\ persisted = [s \in Scopes |-> Null]
  /\ pc = [t \in Threads |-> "idle"]
  /\ owner = None
  /\ intent = [t \in Threads |-> [text |-> 0, rev |-> 0, scope |-> <<t, 1>>]]
  /\ fresh = 0 /\ sent = {} /\ unsent = [t \in Threads |-> 0] /\ cleared = 0
  /\ held = {} /\ uncertainAt = {} /\ superseded = {}

-----------------------------------------------------------------------------
(* User actions.                                                          *)

\* prompt.oninput (WS:3470-3481): a new value, one revision, persisted
\* under the active scope (an empty value deletes the key, CD:108-120).
Type ==
  /\ ~disabled /\ fresh < MaxText /\ rev < MaxRev
  /\ fresh' = fresh + 1
  /\ text' = fresh + 1
  /\ rev' = rev + 1
  /\ persisted' = [persisted EXCEPT ![active] = fresh + 1]
  /\ unsent' = [unsent EXCEPT ![view] = fresh + 1]
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, active, drafts, disabled, pc, owner, intent, sent>>
  /\ UNCHANGED holdVars

Erase ==
  /\ ~disabled /\ text # 0 /\ rev < MaxRev
  /\ text' = 0
  /\ rev' = rev + 1
  /\ persisted' = [persisted EXCEPT ![active] = Null]
  /\ unsent' = [unsent EXCEPT ![view] = 0]
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, active, drafts, disabled, pc, owner, intent,
                 fresh, sent>>
  /\ UNCHANGED holdVars

\* Selecting another thread loads its state and renders it (loadThread,
\* TH:650-661; WS:3787-3815), so a turn the server holds becomes the latest.
\* releaseSendAttempt drops sendAttempt but not inFlightSendThreads.
SwitchThread(u) ==
  /\ u # view /\ rev < MaxRev
  /\ view' = u
  /\ owner' = None
  /\ IF pendingTurn[u] /\ latest[u] < MaxTurns
     THEN /\ latest' = [latest EXCEPT ![u] = @ + 1]
          /\ running' = [running EXCEPT ![u] = TRUE]
          /\ pendingTurn' = [pendingTurn EXCEPT ![u] = FALSE]
          /\ EnterScopeEffect(<<u, latest[u] + 1>>, TRUE)
     ELSE /\ Render(u, running[u])
          /\ UNCHANGED productVars
  /\ cleared' = 0
  /\ UNCHANGED <<pc, intent, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

\* requestInteractionSend (WS:3347-3491) through submitInteraction up to its
\* await (WS:3199-3218). Send is enabled with text, an enabled prompt and
\* loaded drafts (WS:3113-3121), so the draft-load awaits resolve without
\* yielding to another task. Since #719 Send stays enabled while this
\* thread's earlier send posts, but a click then waits for that post to
\* settle and reads the composer afresh, as a click after it would: the
\* model keeps one send per thread, and a click waits for pc = "idle". The
\* intent is captured at the click. threads.submitInteraction reads the
\* thread from viewState behind a dynamic import (graph.js), which is
\* assumed to resolve in the same task.
ClickSend ==
  /\ ~disabled /\ text # 0
  /\ pc[view] = "idle"
  /\ owner # view
  /\ pc' = [pc EXCEPT ![view] = "post"]
  /\ owner' = view
  /\ intent' = [intent EXCEPT ![view] = [text |-> text, rev |-> rev, scope |-> active]]
  \* The prompt stays editable while the send is pending (SCP-019).
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, composerVars, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

\* Send waits before posting: an authored input commit is pending, so
\* requestInteractionSend awaits it (WS settleAuthoredInputCommits). The
\* prompt stays editable; the intent is still the one captured at the click.
ClickSendWaits ==
  /\ ~disabled /\ text # 0
  /\ pc[view] = "idle"
  /\ owner # view
  /\ pc' = [pc EXCEPT ![view] = "reconcile"]
  /\ owner' = view
  /\ intent' = [intent EXCEPT ![view] = [text |-> text, rev |-> rev, scope |-> active]]
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, composerVars, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

\* The wait ends on the same thread and attempt: submitInteraction begins.
Reconciled(t) ==
  /\ pc[t] = "reconcile" /\ view = t /\ owner = t
  /\ pc' = [pc EXCEPT ![t] = "post"]
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, composerVars, owner, intent, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

\* The Send ends without posting: the thread or attempt changed, or an
\* answer did not save. Under HoldFromClick, text stranded in its scope
\* because a newer turn arrived is handed back, as a rejected POST does.
ReconcileEnds(t) ==
  /\ pc[t] = "reconcile"
  /\ LET i == intent[t]
         stranded == IF drafts[i.scope] # NoDraft THEN drafts[i.scope].text ELSE 0
         blocked == HoldFromClick /\ i.scope # Scope(t) /\ stranded # 0 /\ ~Uncertain(i.scope)
         \* The newer text of thread t, shown or not.
         newer == IF view = t THEN text ELSE AwayText(t)
         restore == blocked /\ view = t /\ text = 0
         \* Text typed since wins; the stranded text is retired (SCP-021).
         retire == blocked /\ newer # 0 /\ RetireSuperseded
     IN /\ text' = IF restore THEN stranded ELSE text
        /\ rev' = IF restore THEN rev + 1 ELSE rev
        /\ drafts' = IF restore \/ retire THEN [drafts EXCEPT ![i.scope] = NoDraft] ELSE drafts
        /\ persisted' = IF restore
                        THEN [persisted EXCEPT ![active] = stranded, ![i.scope] = Null]
                        ELSE IF retire THEN [persisted EXCEPT ![i.scope] = Null]
                        ELSE persisted
        /\ superseded' = IF blocked /\ newer # 0 THEN superseded \cup {stranded} ELSE superseded
  /\ pc' = [pc EXCEPT ![t] = "idle"]
  /\ owner' = IF owner = t THEN None ELSE owner
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, active, disabled, intent, fresh, sent, unsent>>
  /\ UNCHANGED <<held, uncertainAt>>

-----------------------------------------------------------------------------
(* The follow-up POST and its continuations (TH:733-812).                 *)

\* submitInteraction's finally resets prompt.disabled, before #719 from the
\* status on screen, whichever thread that is (WS:3334-3338). The send's post
\* ends here, which releases a Send clicked meanwhile.
FinallyEffect(t) ==
  /\ disabled' = (running[view] /\ ~MessagesInParallel)
  /\ pc' = [pc EXCEPT ![t] = "idle"]
  /\ owner' = IF owner = t THEN None ELSE owner

\* A POST rejected before the server records the turn settles in the same
\* task: submitInteraction's catch and
\* finally, then requestInteractionSend's finally (WS:3294-3345, 3485-3490;
\* TH:787-790). The prompt keeps its value. Under CarryUnsentDraft, text
\* stranded in the submitted scope because a newer turn arrived meanwhile
\* is restored into the empty prompt.
PostFails(t) ==
  /\ pc[t] = "post"
  /\ LET i == intent[t]
         stranded == IF drafts[i.scope] # NoDraft THEN drafts[i.scope].text ELSE 0
         blocked == CarryUnsentDraft /\ i.scope # Scope(t) /\ stranded # 0 /\ ~Uncertain(i.scope)
         \* The newer text of thread t, shown or not.
         newer == IF view = t THEN text ELSE AwayText(t)
         restore == blocked /\ view = t /\ text = 0
         \* Text typed since wins; the stranded text is retired (SCP-021).
         retire == blocked /\ newer # 0 /\ RetireSuperseded
     IN /\ text' = IF restore THEN stranded ELSE text
        /\ rev' = IF restore THEN rev + 1 ELSE rev
        /\ drafts' = IF restore \/ retire THEN [drafts EXCEPT ![i.scope] = NoDraft] ELSE drafts
        /\ persisted' = IF restore
                        THEN [persisted EXCEPT ![active] = stranded, ![i.scope] = Null]
                        ELSE IF retire THEN [persisted EXCEPT ![i.scope] = Null]
                        ELSE persisted
        /\ superseded' = IF blocked /\ newer # 0 THEN superseded \cup {stranded} ELSE superseded
  /\ FinallyEffect(t)
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, active, intent, fresh, sent, unsent>>
  /\ UNCHANGED <<held, uncertainAt>>

\* The POST fails with a network or server error, before or after the
\* server recorded the turn (WS confirmationSendFailureMayHaveCommitted).
\* Under HoldUncertain the submission is held once the turn it created
\* arrives. Text an unrelated newer turn left in the submitted scope is
\* handed back as for a rejection, unless the send's own turn already
\* arrived (SCP-019).
PostLost(t) ==
  /\ pc[t] \in {"post", "posted"}
  /\ LET i == intent[t]
         created == IF pc[t] # "posted" THEN 0
                    ELSE IF pendingTurn[t] THEN latest[t] + 1 ELSE latest[t]
         landedNow == created # 0 /\ latest[t] >= created
         stranded == IF drafts[i.scope] # NoDraft THEN drafts[i.scope].text ELSE 0
         blocked == HandBackUncertain /\ i.scope # Scope(t) /\ stranded # 0
                    /\ ~Uncertain(i.scope) /\ ~landedNow
         newer == IF view = t THEN text ELSE AwayText(t)
         restore == blocked /\ view = t /\ text = 0
         retire == blocked /\ newer # 0 /\ RetireSuperseded
         \* The renderer matches the turn by the submission's text, so an
         \* earlier failed send of the same draft that created one counts.
         earlier == {h \in held : h.scope = i.scope /\ h.rev = i.rev /\ h.landedAt # 0}
         landedAt == IF created = 0 /\ earlier # {}
                     THEN (CHOOSE h \in earlier : TRUE).landedAt ELSE created IN
     /\ held' = IF HoldUncertain
                THEN {h \in held : h.scope # i.scope}
                     \cup {[scope |-> i.scope, rev |-> i.rev, landedAt |-> landedAt, text |-> i.text]}
                ELSE held
     /\ uncertainAt' = uncertainAt \cup {[text |-> i.text, scope |-> i.scope]}
     /\ text' = IF restore THEN stranded ELSE text
     /\ rev' = IF restore THEN rev + 1 ELSE rev
     /\ drafts' = IF restore \/ retire THEN [drafts EXCEPT ![i.scope] = NoDraft] ELSE drafts
     /\ persisted' = IF restore
                     THEN [persisted EXCEPT ![active] = stranded, ![i.scope] = Null]
                     ELSE IF retire THEN [persisted EXCEPT ![i.scope] = Null]
                     ELSE persisted
     /\ superseded' = IF blocked /\ newer # 0 THEN superseded \cup {stranded} ELSE superseded
  /\ FinallyEffect(t)
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, active, intent, fresh, sent, unsent>>

\* The server records the follow-up turn before it starts the run and
\* answers (crates/relayer-app-server/src/api/threads.rs:600-666). Since #719
\* it does so while other turns run; before, only while the thread had no
\* active interaction (interaction_in_progress), and otherwise PostFails.
\* ~pendingTurn bounds the model to one unloaded turn per thread. A start
\* that fails after the turn is recorded restores the draft through the
\* retry path, which is not modeled.
PostInserted(t) ==
  /\ pc[t] = "post"
  /\ ~pendingTurn[t] /\ (MessagesInParallel \/ ~running[t]) /\ latest[t] < MaxTurns
  /\ pc' = [pc EXCEPT ![t] = "posted"]
  /\ pendingTurn' = [pendingTurn EXCEPT ![t] = TRUE]
  /\ sent' = sent \cup {intent[t].text}
  /\ unsent' = [unsent EXCEPT ![t] = IF @ = intent[t].text THEN 0 ELSE @]
  /\ cleared' = 0
  /\ UNCHANGED <<view, latest, running, composerVars, owner, intent, fresh>>
  /\ UNCHANGED holdVars

PostSucceeds(t) ==
  /\ pc[t] = "posted"
  /\ pc' = [pc EXCEPT ![t] = "refresh"]
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, composerVars, owner, intent, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

\* A newer turn becomes the thread's latest; if the thread is on screen,
\* renderThread() moves the composer to the new turn's scope.
TurnArrivesEffect(t) ==
  /\ latest' = [latest EXCEPT ![t] = @ + 1]
  /\ running' = [running EXCEPT ![t] = TRUE]
  /\ pendingTurn' = [pendingTurn EXCEPT ![t] = FALSE]
  /\ IF view = t
     THEN EnterScopeEffect(<<t, latest[t] + 1>>, TRUE)
     ELSE UNCHANGED composerVars

\* Settlement after a successful POST (WS:3240-3269, CS:1-55), then the
\* finally blocks in the same task:
\* settleComposerSubmission clears the prompt only on the same thread, same
\* scope, and same prompt revision; clearSubmittedComposerDraft drops the
\* submitted scope's draft and its persisted text only when its retained
\* revision equals the submitted one, comparing composerPromptRevision
\* before the prompt is cleared.
Settle(t) ==
  /\ pc[t] = "settle"
  /\ LET i == intent[t]
         clearPrompt == view = t /\ active = i.scope /\ rev = i.rev
         \* A scope with no entry retains no revision (undefined in WS:1209).
         retained == IF active = i.scope THEN rev
                     ELSE IF drafts[i.scope] # NoDraft THEN drafts[i.scope].rev
                     ELSE MaxRev + 99
         dropDraft == retained = i.rev
     IN /\ text' = IF clearPrompt THEN 0 ELSE text
        /\ rev' = IF clearPrompt THEN i.rev + 1 ELSE rev
        /\ drafts' = IF dropDraft THEN [drafts EXCEPT ![i.scope] = NoDraft] ELSE drafts
        /\ persisted' = IF dropDraft THEN [persisted EXCEPT ![i.scope] = Null]
                        ELSE persisted
        /\ cleared' = IF clearPrompt /\ text # 0 THEN text ELSE 0
  /\ FinallyEffect(t)
  /\ UNCHANGED <<view, productVars, active, intent, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

-----------------------------------------------------------------------------
(* The product advancing on its own.                                      *)

\* Polling or an event loads the accepted follow-up (TH:schedulePendingRefresh).
TurnArrives(t) ==
  /\ pendingTurn[t] /\ pc[t] # "refresh" /\ rev < MaxRev
  /\ TurnArrivesEffect(t)
  /\ cleared' = 0
  /\ UNCHANGED <<view, pc, owner, intent, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

\* A turn created elsewhere in the thread arrives and becomes the latest.
InvokeTurn(t) ==
  /\ OtherTurns /\ ~pendingTurn[t] /\ ~running[t] /\ latest[t] < MaxTurns /\ rev < MaxRev
  /\ TurnArrivesEffect(t)
  /\ cleared' = 0
  /\ UNCHANGED <<view, pc, owner, intent, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

TurnFinishes(t) ==
  /\ running[t] /\ ~pendingTurn[t]
  /\ running' = [running EXCEPT ![t] = FALSE]
  /\ disabled' = IF view = t THEN FALSE ELSE disabled
  /\ cleared' = 0
  /\ UNCHANGED <<view, latest, pendingTurn, active, drafts, text, rev, persisted,
                 pc, owner, intent, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

\* renderThread() for an unrelated reason re-renders the thread on screen.
BackgroundRender ==
  /\ BackgroundRenders /\ rev < MaxRev
  /\ Render(view, running[view])
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, pc, owner, intent, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

\* After the POST, submitInteraction refreshes the thread only if the
\* navigation entry [thread, turn, layer path] is unchanged (TH:797-808;
\* workspace-navigation.js:31-38), and refreshState drops a response for a
\* thread no longer on screen (TH:460-463). The refresh is a fetch, so it is
\* its own task. RefreshSkipped models a changed entry, such as a send from
\* a nested layer followed by leaving and returning to the thread, which
\* resets the layer path, or a failed refresh (TH:809-812).
RefreshReturnsAction(t) ==
  /\ pc[t] = "refresh"
  /\ (view = t /\ pendingTurn[t]) => rev < MaxRev   \* bound only
  /\ pc' = [pc EXCEPT ![t] = "settle"]
  /\ IF view = t /\ pendingTurn[t]
     THEN TurnArrivesEffect(t)
     ELSE UNCHANGED <<productVars, composerVars>>
  /\ cleared' = 0
  /\ UNCHANGED <<view, owner, intent, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

RefreshSkipped(t) ==
  /\ pc[t] = "refresh"
  /\ pc' = [pc EXCEPT ![t] = "settle"]
  /\ cleared' = 0
  /\ UNCHANGED <<view, productVars, composerVars, owner, intent, fresh, sent, unsent>>
  /\ UNCHANGED holdVars

-----------------------------------------------------------------------------
SystemStep ==
  \E t \in Threads :
    \/ PostInserted(t) \/ PostSucceeds(t) \/ PostFails(t) \/ PostLost(t)
    \/ Reconciled(t) \/ ReconcileEnds(t)
    \/ RefreshReturnsAction(t) \/ RefreshSkipped(t)
    \/ Settle(t)

Next ==
  \/ Type \/ Erase \/ ClickSend \/ ClickSendWaits
  \/ \E u \in Threads : SwitchThread(u)
  \/ SystemStep
  \/ \E t \in Threads : TurnArrives(t) \/ TurnFinishes(t) \/ InvokeTurn(t)
  \/ BackgroundRender

\* Every send continuation runs once the POST answers.
Fairness ==
  /\ \A t \in Threads :
       /\ WF_vars(PostInserted(t) \/ PostFails(t))
       /\ WF_vars(PostSucceeds(t))
       /\ WF_vars(RefreshReturnsAction(t) \/ RefreshSkipped(t))
       /\ WF_vars(Settle(t))
       /\ WF_vars(Reconciled(t) \/ ReconcileEnds(t))

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

Act(s) ==
  LET n == s[1] IN
  CASE n = "Type" -> Type
    [] n = "Erase" -> Erase
    [] n = "ClickSend" -> ClickSend
    [] n = "ClickSendWaits" -> ClickSendWaits
    [] n = "Reconciled" -> Reconciled(s[2])
    [] n = "ReconcileEnds" -> ReconcileEnds(s[2])
    [] n = "PostLost" -> PostLost(s[2])
    [] n = "InvokeTurn" -> InvokeTurn(s[2])
    [] n = "SwitchThread" -> SwitchThread(s[2])
    [] n = "PostInserted" -> PostInserted(s[2])
    [] n = "PostSucceeds" -> PostSucceeds(s[2])
    [] n = "PostFails" -> PostFails(s[2])
    [] n = "RefreshReturns" -> RefreshReturnsAction(s[2])
    [] n = "RefreshSkipped" -> RefreshSkipped(s[2])
    [] n = "Settle" -> Settle(s[2])
    [] n = "TurnArrives" -> TurnArrives(s[2])
    [] n = "TurnFinishes" -> TurnFinishes(s[2])
    [] n = "BackgroundRender" -> BackgroundRender

-----------------------------------------------------------------------------
(* Safety.                                                                *)

TypeOK ==
  /\ view \in Threads
  /\ \A t \in Threads : latest[t] \in 1..MaxTurns /\ pc[t] \in Phases
  /\ text \in Texts /\ rev \in Nat
  /\ active = Scope(view)

\* The text the composer shows for thread t: the prompt on screen, or what
\* render() would restore on entering t now.
Shown(t) == IF view = t THEN text ELSE EnterScope(Scope(t)).text

\* SCP-016: "Saved-thread ... drafts survive navigation and restart. Send or
\* explicit clearing removes only the applicable draft." SCP-018: text
\* written while a send is in flight survives the new turn loading. The user's latest unsent text in a thread is what
\* that thread's composer shows, except while a send owns that text: a
\* successful send removes it, and a failed one must hand it back.
Sending(t) == pc[t] # "idle" /\ intent[t].text = unsent[t]
UnsentDraftSurvives ==
  \A t \in Threads : unsent[t] # 0 /\ ~Sending(t) => Shown(t) = unsent[t]

\* The same promise, narrowed to the settlement step: a successful send
\* removes from the prompt only text that send carried.
SettlementClearsOnlySentText == cleared = 0 \/ cleared \in sent

\* "Send ... removes ... the applicable draft" (SCP-016): once a thread's
\* send has settled, its composer does not offer the sent text again.
\* A send that may have been sent leaves its text where it was: in the prompt
\* of the scope it was sent from, not carried into a newer turn (SCP-019).
SentTextIsNotShownAgain ==
  \A t \in Threads : pc[t] = "idle" /\ Shown(t) # 0 =>
    \/ Shown(t) \notin sent
    \/ [text |-> Shown(t), scope |-> Scope(t)] \in uncertainAt
    \* A send that may have gone through follows the user until its own turn
    \* arrives (SCP-019).
    \/ \E h \in held : h.text = Shown(t) /\ (h.landedAt = 0 \/ latest[t] < h.landedAt)

\* "Text the user typed since is kept, and the earlier text is not restored"
\* (SCP-021): stranded text the user replaced is not shown again.
SupersededStaysGone == \A t \in Threads : Shown(t) \notin superseded

\* One follow-up POST per thread at a time: a Send clicked while one posts
\* waits for it (WS requestInteractionSend, postingSends).
OneSendPerThread == \A t \in Threads : pc[t] = "post" => intent[t].scope[1] = t

\* #719: thread messages run in parallel. While the thread on screen has a
\* running turn and no send of its own in flight, the prompt is usable, so
\* the user can type and Send; and a message the user sent is recorded
\* beside the running turn instead of being refused.
MessageNeverWaitsOnRun ==
  /\ \A t \in Threads : view = t /\ running[t] => ~disabled
  /\ \A t \in Threads :
       pc[t] = "post" /\ running[t] /\ ~pendingTurn[t] /\ latest[t] < MaxTurns
         => ENABLED PostInserted(t)

-----------------------------------------------------------------------------
(* Liveness.                                                              *)

\* A send always releases its thread's Send button.
SendReleases == \A t \in Threads : pc[t] # "idle" ~> pc[t] = "idle"

=============================================================================
