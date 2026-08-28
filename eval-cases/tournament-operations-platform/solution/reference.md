# Tournament operations reference model

The sealed model treats registrations and original seeds as durable identity, uses deterministic snake pools and complete round robins, and derives standings from final active-team results. Qualification waits until every active pool match is final or cancelled. Two-pool semifinals cross first against second; later winners populate the final.

The v1 bracket topology accepts exactly two pools and two qualifiers per pool, rejecting other topology values. Team count and identity, pool size, duration, venue windows, and court capacity remain variable inputs.

Scheduling is constraint satisfaction over declared venue windows, courts, match duration, and team availability. Every known-participant nonterminal match remains represented. An impossible plan is an explicit infeasible result with conflicts. Withdrawal cancels future matches and removes eligibility without rewriting completed history. Rescheduling preserves match identity, rejects terminal/colliding/out-of-window moves, and leaves rejected input unchanged.

Qualification observes only the documented JSON-compatible exports and the rendered browser artifact. Browser actions publish their public-export identity, JSON arguments, and returned state so the verifier can replay the operation independently. It never matches candidate source or a reference patch.
