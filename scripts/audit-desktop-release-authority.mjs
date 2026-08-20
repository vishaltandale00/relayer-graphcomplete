import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_REPOSITORY = "vishaltandale00/relayer-graphcomplete";
const EXPECTED_OIDC_PREFIX = "repo:vishaltandale00@9222298/relayer-graphcomplete@1327816644";

const ENVIRONMENTS = Object.freeze({
  "desktop-production": Object.freeze({
    branches: ["main", "desktop-v*"],
    secrets: [
      "RELAYER_DESKTOP_APPLE_API_ISSUER",
      "RELAYER_DESKTOP_APPLE_API_KEY",
      "RELAYER_DESKTOP_APPLE_API_KEY_ID",
      "RELAYER_DESKTOP_CSC_KEY_PASSWORD",
      "RELAYER_DESKTOP_CSC_LINK",
      "RELAYER_DESKTOP_SIGN_IDENTITY",
    ],
    variables: [],
  }),
  "desktop-production-windows": Object.freeze({
    branches: ["main", "desktop-v*"],
    secrets: [],
    variables: [
      "AZURE_CLIENT_ID",
      "AZURE_SUBSCRIPTION_ID",
      "AZURE_TENANT_ID",
      "RELAYER_WINDOWS_CERTIFICATE_PROFILE",
      "RELAYER_WINDOWS_PUBLISHER_NAME",
    ],
  }),
  "desktop-update-preview": Object.freeze({
    branches: ["desktop-v*"],
    secrets: [],
    variables: [],
  }),
  "desktop-update-stable-promotion": Object.freeze({
    branches: ["main"],
    secrets: [],
    variables: [],
  }),
});

const REPOSITORY_VARIABLES = Object.freeze([
  "DESKTOP_UPDATE_BUCKET",
  "DESKTOP_UPDATE_PREVIEW_ROLE_ARN",
  "DESKTOP_UPDATE_STABLE_ROLE_ARN",
]);

function includesAll(actual, expected) {
  const available = new Set(actual);
  return expected.every((item) => available.has(item));
}

function matchesExactly(actual, expected) {
  return actual.length === expected.length && includesAll(actual, expected);
}

function ruleTypes(ruleset) {
  return (ruleset?.rules || []).map((rule) => rule.type);
}

function refIncludes(ruleset, expected) {
  return (ruleset?.conditions?.ref_name?.include || []).includes(expected);
}

export function evaluateDesktopReleaseAuthority(snapshot, { windowsCandidateEnabled = false } = {}) {
  const results = [];
  const record = (passed, label) => results.push({ passed: Boolean(passed), label });

  record(snapshot.repository?.default_branch === "main", "default branch is main");
  record(snapshot.repository?.permissions?.admin === true, "current GitHub identity is a repository administrator");

  for (const [name, expected] of Object.entries(ENVIRONMENTS)) {
    const environment = snapshot.environments?.[name];
    const requiredVariables = name === "desktop-production-windows" && !windowsCandidateEnabled
      ? expected.variables.filter((variable) => variable !== "RELAYER_WINDOWS_PUBLISHER_NAME")
      : expected.variables;
    record(Boolean(environment), `environment ${name} exists`);
    record(
      environment?.protection_rules?.some((rule) => rule.type === "branch_policy"),
      `environment ${name} enforces deployment branch policies`,
    );
    record(matchesExactly(environment?.branches || [], expected.branches), `environment ${name} allows only its required refs`);
    record(includesAll(environment?.secrets || [], expected.secrets), `environment ${name} has required secret names`);
    record(includesAll(environment?.variables || [], requiredVariables), `environment ${name} has required variable names`);
  }

  record(
    includesAll(snapshot.repositoryVariables || [], REPOSITORY_VARIABLES),
    "repository has all target-specific AWS publication variables",
  );
  record(snapshot.oidc?.use_default === true, "GitHub OIDC uses the default environment-bound subject shape");
  record(snapshot.oidc?.sub_claim_prefix === EXPECTED_OIDC_PREFIX, "GitHub OIDC subject uses immutable owner and repository IDs");

  const activeRulesets = (snapshot.rulesets || []).filter((ruleset) => ruleset.enforcement === "active");
  const mainRuleset = activeRulesets.find((ruleset) =>
    ruleset.target === "branch" && (refIncludes(ruleset, "~DEFAULT_BRANCH") || refIncludes(ruleset, "refs/heads/main"))
  );
  const mainTypes = ruleTypes(mainRuleset);
  const requiredChecks = mainRuleset?.rules?.find((rule) => rule.type === "required_status_checks")?.parameters;
  record(Boolean(mainRuleset), "an active ruleset targets main");
  record(includesAll(mainTypes, ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]), "main blocks deletion/direct updates and requires PR plus CI");
  record(
    Boolean(mainRuleset) && (mainRuleset.bypass_actors || []).every((actor) => actor.bypass_mode === "pull_request"),
    "main has no always-bypass actor",
  );
  record(
    requiredChecks?.strict_required_status_checks_policy === true &&
      requiredChecks?.required_status_checks?.some((check) => check.context === "check" && check.integration_id === 15368),
    "main requires the current GitHub Actions check job",
  );

  const tagRuleset = activeRulesets.find((ruleset) =>
    ruleset.target === "tag" && refIncludes(ruleset, "refs/tags/desktop-v*")
  );
  const tagTypes = ruleTypes(tagRuleset);
  record(Boolean(tagRuleset), "an active ruleset targets desktop-v* tags");
  record(includesAll(tagTypes, ["creation", "deletion", "non_fast_forward"]), "desktop release tags restrict creation, deletion, and replacement");
  record(
    tagRuleset?.bypass_actors?.length === 1 &&
      tagRuleset.bypass_actors[0].actor_type === "RepositoryRole" &&
      tagRuleset.bypass_actors[0].actor_id === 5 &&
      tagRuleset.bypass_actors[0].bypass_mode === "always",
    "repository administrators are the only configured desktop-tag bypass role",
  );

  return results;
}

async function ghJson(repository, path) {
  const endpoint = path ? `repos/${repository}/${path}` : `repos/${repository}`;
  const { stdout } = await execFileAsync("gh", [
    "api",
    endpoint,
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function readEnvironment(repository, environment) {
  const [configuration, branchPolicies, secrets, variables] = await Promise.all([
    ghJson(repository, `environments/${environment}`),
    ghJson(repository, `environments/${environment}/deployment-branch-policies`),
    ghJson(repository, `environments/${environment}/secrets`),
    ghJson(repository, `environments/${environment}/variables`),
  ]);
  return {
    ...configuration,
    branches: (branchPolicies.branch_policies || []).map((policy) => policy.name),
    secrets: (secrets.secrets || []).map((secret) => secret.name),
    variables: (variables.variables || []).map((variable) => variable.name),
  };
}

export async function readDesktopReleaseAuthority(repository = DEFAULT_REPOSITORY) {
  const [repositoryMetadata, repositoryVariables, oidc, rulesetList, environmentEntries] = await Promise.all([
    ghJson(repository, ""),
    ghJson(repository, "actions/variables"),
    ghJson(repository, "actions/oidc/customization/sub"),
    ghJson(repository, "rulesets"),
    Promise.all(Object.keys(ENVIRONMENTS).map(async (name) => [name, await readEnvironment(repository, name)])),
  ]);
  const rulesets = await Promise.all((rulesetList || []).map((ruleset) => ghJson(repository, `rulesets/${ruleset.id}`)));
  return {
    repository: repositoryMetadata,
    repositoryVariables: (repositoryVariables.variables || []).map((variable) => variable.name),
    oidc,
    rulesets,
    environments: Object.fromEntries(environmentEntries),
  };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const windowsCandidateEnabled = arguments_.includes("--include-windows-candidate");
  const repository = arguments_.find((argument) => !argument.startsWith("--")) || DEFAULT_REPOSITORY;
  const snapshot = await readDesktopReleaseAuthority(repository);
  const results = evaluateDesktopReleaseAuthority(snapshot, { windowsCandidateEnabled });
  console.log(`INFO  Windows candidate authority is ${windowsCandidateEnabled ? "included" : "excluded"} from this audit.`);
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.label}`);
  }
  const failures = results.filter((result) => !result.passed);
  if (failures.length > 0) {
    throw new Error(`Desktop release authority audit failed with ${failures.length} unmet requirement(s).`);
  }
}

if (process.argv[1]?.endsWith("audit-desktop-release-authority.mjs")) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
