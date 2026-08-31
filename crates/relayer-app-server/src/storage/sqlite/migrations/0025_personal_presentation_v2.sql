INSERT INTO interactions(
    id,thread_id,sequence,text,created_at,completion_status,permission_profile_id
)
VALUES (-3,-1,3,'Personal presentation V2','0','profile_pending','auto');

INSERT INTO personal_presentation_versions(version_key,profile_interaction_id)
VALUES ('personal-presentation-v2',-3);
