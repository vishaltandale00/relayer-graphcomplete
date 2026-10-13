-- Only trusted API preparation rejection records these receipts, after an exact
-- native inventory read proves the refused key owns no native call. Legacy,
-- transport-uncertain and prepared-call failures are never backfilled.
CREATE TABLE invocation_preparation_refusals (
 result_interaction_id INTEGER PRIMARY KEY REFERENCES interactions(id),
 native_status INTEGER NOT NULL CHECK(native_status IN (400,401,403,404,409,422))
);
