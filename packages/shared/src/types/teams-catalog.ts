import type {
  CompanyPortabilityAdapterOverride,
  CompanyPortabilityAgentSelection,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityPreviewResult,
} from "./company-portability.js";

export type CatalogTeamKind = "bundled" | "optional";

export type CatalogTeamTrustLevel =
  | "markdown_only"
  | "assets"
  | "scripts_executables"
  | "external_sources";

export type CatalogTeamCompatibility = "compatible" | "unknown" | "invalid";

export type CatalogTeamFileKind =
  | "team"
  | "agent"
  | "project"
  | "task"
  | "skill"
  | "extension"
  | "readme"
  | "reference"
  | "script"
  | "asset"
  | "markdown"
  | "other";

export type CatalogTeamSkillRequirementType =
  | "catalog"
  | "local"
  | "skills_sh"
  | "github"
  | "url"
  | "local_path"
  | "agent_package";

export interface CatalogTeamSkillRequirement {
  type: CatalogTeamSkillRequirementType;
  ref: string;
  agentSlugs: string[];
  resolved: boolean;
  catalogSkillId?: string;
  catalogSkillKey?: string;
  localPath?: string;
  sourceLocator?: string;
  sourceRef?: string;
}

export interface CatalogTeamEnvInputSummary {
  key: string;
  agentSlug: string | null;
  projectSlug: string | null;
  kind: "secret" | "plain";
  requirement: "required" | "optional";
}

export interface CatalogTeamSourceRef {
  type: Exclude<CatalogTeamSkillRequirementType, "catalog" | "local"> | "include";
  ref: string;
  pinned: boolean;
}

export interface CatalogTeamFile {
  path: string;
  kind: CatalogTeamFileKind;
  sizeBytes: number;
  sha256: string;
}

export interface CatalogTeam {
  id: string;
  key: string;
  kind: CatalogTeamKind;
  category: string;
  slug: string;
  name: string;
  description: string;
  path: string;
  entrypoint: "TEAM.md";
  schema: "agentcompanies/v1";
  defaultInstall: boolean;
  recommendedForCompanyTypes: string[];
  tags: string[];
  counts: {
    agents: number;
    projects: number;
    tasks: number;
    routines: number;
    localSkills: number;
    catalogSkills: number;
    externalSkillSources: number;
  };
  rootAgentSlugs: string[];
  agentSlugs: string[];
  projectSlugs: string[];
  requiredSkills: CatalogTeamSkillRequirement[];
  envInputs: CatalogTeamEnvInputSummary[];
  sourceRefs: CatalogTeamSourceRef[];
  files: CatalogTeamFile[];
  trustLevel: CatalogTeamTrustLevel;
  compatibility: CatalogTeamCompatibility;
  contentHash: string;
  packageName?: string;
  packageVersion?: string;
}

export interface CatalogTeamListQuery {
  kind?: CatalogTeamKind;
  category?: string;
  q?: string;
}

export interface CatalogTeamFileDetail {
  catalogTeamId: string;
  path: string;
  kind: CatalogTeamFileKind;
  content: string;
  language: string | null;
  markdown: boolean;
}

export interface CatalogTeamSourcePolicy {
  allowExternalSources?: boolean;
  allowUnpinnedOptionalSources?: boolean;
  allowLocalPathSources?: boolean;
}

export interface CatalogTeamImportOptions {
  targetManagerAgentId?: string | null;
  targetManagerSlug?: string | null;
  include?: Partial<CompanyPortabilityInclude>;
  agents?: CompanyPortabilityAgentSelection;
  collisionStrategy?: CompanyPortabilityCollisionStrategy;
  nameOverrides?: Record<string, string>;
  selectedFiles?: string[];
  sourcePolicy?: CatalogTeamSourcePolicy;
}

export interface CatalogTeamInstallOptions extends CatalogTeamImportOptions {
  adapterOverrides?: Record<string, CompanyPortabilityAdapterOverride>;
}

export type CatalogTeamSkillPreparationAction =
  | "already_in_package"
  | "catalog_install_required"
  | "external_import_required"
  | "blocked";

export interface CatalogTeamSkillPreparation {
  type: CatalogTeamSkillRequirementType;
  ref: string;
  agentSlugs: string[];
  action: CatalogTeamSkillPreparationAction;
  catalogSkillId: string | null;
  catalogSkillKey: string | null;
  sourceLocator: string | null;
  sourceRef: string | null;
  reason: string | null;
}

export interface CatalogTeamImportPreviewResult {
  team: CatalogTeam;
  portabilityPreview: CompanyPortabilityPreviewResult;
  skillPreparations: CatalogTeamSkillPreparation[];
  warnings: string[];
  errors: string[];
}

export interface CatalogTeamInstallResult {
  team: CatalogTeam;
  portabilityImport: CompanyPortabilityImportResult;
  skillPreparations: CatalogTeamSkillPreparation[];
  warnings: string[];
}
