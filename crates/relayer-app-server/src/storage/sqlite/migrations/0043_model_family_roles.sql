-- Family order already encodes the product's default-model preference.
-- Availability does not select a substitute; unavailable orchestrators block.
-- Never read a conversation receipt or change the user's selected default family.
ALTER TABLE model_family_members ADD COLUMN roles_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(roles_json) AND json_type(roles_json)='array');
UPDATE model_family_members SET roles_json='[{"name":"orchestrator"}]'
WHERE position=(SELECT MIN(candidate.position) FROM model_family_members candidate
 WHERE candidate.family_id=model_family_members.family_id);
UPDATE model_families SET revision=revision+1 WHERE EXISTS (SELECT 1 FROM model_family_members member WHERE member.family_id=model_families.id);

-- Billing consent narrows execution authority independently of family/model choice.
-- Semantic children share their parent's product thread and inherit this constraint.
CREATE TABLE thread_execution_constraints (
 thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
 required_provider_adapter_id TEXT NOT NULL CHECK(required_provider_adapter_id='codex-subscription')
);
