INSERT INTO interactions(
    id,thread_id,sequence,text,created_at,completion_status,permission_profile_id
)
VALUES (-4,-1,4,'Personal presentation V3','0','profile_pending','auto');

INSERT INTO personal_presentation_versions(version_key,profile_interaction_id)
VALUES ('personal-presentation-v3',-4);
