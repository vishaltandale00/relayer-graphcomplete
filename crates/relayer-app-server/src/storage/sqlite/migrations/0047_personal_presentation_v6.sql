-- Keep the V6 profile identity consistent with the explicit calibration version.
-- V5 and V7 remain unpublished in the production catalog.
INSERT INTO interactions(id,thread_id,sequence,text,created_at,completion_status,permission_profile_id)
VALUES (-7,-1,7,'Personal presentation V6','0','profile_pending','auto');
INSERT INTO personal_presentation_versions(version_key,profile_interaction_id)
VALUES ('personal-presentation-v6',-7);
