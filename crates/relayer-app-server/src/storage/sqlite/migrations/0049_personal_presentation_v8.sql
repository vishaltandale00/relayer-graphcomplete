-- V8 adds concise Node Details without changing published definitions or pins.
-- V5/V7 remain reserved for calibration; active product policy stays unchanged.
INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,permission_profile_id)
VALUES (-9,-1,9,'Personal presentation V8','0','profile_pending','auto');
INSERT INTO personal_presentation_versions(version_key,profile_interaction_id)
VALUES ('personal-presentation-v8',-9);
