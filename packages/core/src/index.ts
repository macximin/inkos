// Models
export { type BookConfig, type Platform, type Genre, type BookStatus, type FanficMode, type ChapterReviewMode, type RevisionGate, BookConfigSchema, PlatformSchema, GenreSchema, BookStatusSchema, FanficModeSchema, normalizePlatformId, normalizePlatformOrOther, resolveChapterReviewMode, resolveRevisionGate } from "./models/book.js";
export {
  type ChapterArcProvenance,
  type ChapterStoryRailProvenance,
  type ChapterMeta,
  type ChapterStatus,
  ChapterArcProvenanceSchema,
  ChapterStoryRailProvenanceSchema,
  ChapterMetaSchema,
  ChapterStatusSchema,
} from "./models/chapter.js";
export { type ProjectConfig, type LLMConfig, type NotifyChannel, type DetectionConfig, type QualityGates, type FoundationConfig, type WritingConfig, type AgentLLMOverride, type InputGovernanceMode, type ResearchSearchConfig, type ProductionConfig, type ProductionKernelMode, type SurfaceGatewayMode, ProjectConfigSchema, LLMConfigSchema, AgentLLMOverrideSchema, DetectionConfigSchema, QualityGatesSchema, FoundationConfigSchema, WritingConfigSchema, InputGovernanceModeSchema, ResearchSearchConfigSchema, ProductionConfigSchema, ProductionKernelModeSchema, SurfaceGatewayModeSchema } from "./models/project.js";
export { type CurrentState, type ParticleLedger, type PendingHooks, type PendingHook, type LedgerEntry } from "./models/state.js";
export {
  type GenreProfile,
  type GenreProfileReadReceipt,
  type ParsedGenreProfile,
  type ResolvedGenreProfile,
  GenreProfileReadReceiptSchema,
  GenreProfileSchema,
  parseGenreProfile,
} from "./models/genre-profile.js";
export {
  type BookRules,
  type ParsedBookRules,
  BookRulesSchema,
  FutureAdvantageSchema,
  FutureAdvantageResearchPolicySchema,
  parseBookRules,
  tryParseBookRulesFrontmatter,
} from "./models/book-rules.js";
export { type DetectionHistoryEntry, type DetectionStats } from "./models/detection.js";
export { type StyleProfile } from "./models/style-profile.js";
export {
  FireflyEntryContractSchema,
  FireflyPlanningAdmissionSchema,
  assertApprovedFireflyPlanningAdmission,
  hashEntryContract,
  type FireflyEntryContract,
  type FireflyPlanningAdmission,
} from "./planning/entry-contract.js";
export {
  FireflyPitchEntryGateSchema,
  FireflyPitchReviewCandidateV3Schema,
  FireflyPitchReviewPacketV3Schema,
  buildFireflyPitchReviewPacketV3,
  hashCanonicalJson as hashPitchReviewCanonicalJson,
  type FireflyPitchReviewPacketV3,
} from "./storyyard/pitch-review-packet.js";
export {
  ReferencePackSchema,
  ReferenceStoryIndexEntrySchema,
  ReferenceStyleExampleSchema,
  ReferenceBindingSchema,
  ReferenceTransformationSegmentSchema,
  ReferenceTransformationSchema,
  type ReferencePack,
  type ReferenceStoryIndexEntry,
  type ReferenceStyleExample,
  type ReferenceBinding,
  type ReferenceTransformationSegment,
  type ReferenceTransformation,
  type WriterReferenceContext,
} from "./reference/schema.js";
export {
  ReferencePackStore,
  sha256ReferenceText,
  type BindReferencePackInput,
} from "./reference/store.js";
export {
  ensureFireflyLongformPreflight,
  type FireflyPreflightReceipt,
} from "./reference/firefly-preflight.js";
export {
  ReferenceTransformationHilStore,
  ReferenceTransformationCandidateSchema,
  TransformationComparisonReportSchema,
  COMMERCIAL_EVALUATION_FORMULA,
  scoreCommercialEvaluation,
  type CommercialEvaluation,
  type ReferenceTransformationCandidate,
  type ReferenceTransformationHilCandidateView,
  type TransformationComparisonReport,
} from "./reference/hil-store.js";
export {
  ReferenceHilDecisionReceiptSchema,
  ReferenceHilApplyStateSchema,
  ReferenceHilApplyTransitionSchema,
  createReferenceHilDecisionReceipt,
  buildReferenceHilApplyTransition,
  appendReferenceHilApplyTransition,
  loadReferenceHilOperation,
  referenceHilOperationDir,
  referenceHilDecisionRelativePath,
  referenceHilTransitionRelativePath,
  type ReferenceHilDecisionReceipt,
  type ReferenceHilApplyState,
  type ReferenceHilApplyTransition,
} from "./reference/hil-apply-operation.js";
export { assertChapterApprovalReady } from "./state/chapter-approval.js";
export {
  beginBookMutationJournal,
  commitBookMutationJournal,
  rollbackBookMutationJournal,
  runBookMutationTransaction,
  recoverBookMutationTransactions,
  type BookMutationJournal,
} from "./state/book-mutation-journal.js";
export {
  ChapterCommitCapabilitySchema,
  ChapterCommitReceiptSchema,
  ChapterCommitRepairReceiptSchema,
  chapterCommitReceiptRelativePath,
  writeChapterCommitReceipt,
  listChapterCommitReceiptsForAttempt,
  repairChapterCommitEvidence,
  type ChapterCommitCapability,
  type ChapterCommitReceipt,
  type ChapterCommitRepairReceipt,
} from "./state/chapter-commit-receipt.js";
export {
  FireflyReviewCandidateSchema,
  FireflyReviewDecisionSchema,
  FireflyReviewPacketSchema,
  assertFireflyReviewPacketIdentity,
  buildFireflyReviewPackets,
  type FireflyReviewCandidate,
  type FireflyReviewDecision,
  type FireflyReviewPacket,
} from "./storyyard/review-packet.js";
export {
  FireflyCanaryIsolationProjectionSchema,
  FireflyReviewCandidateV2Schema,
  FireflyReviewDecisionV2Schema,
  FireflyReviewPacketV2Schema,
  FireflySurfaceClassificationReceiptSchema,
  FireflySurfaceMatchV2Schema,
  assertFireflyReviewDecisionV2MatchesPacket,
  assertFireflyReviewPacketV2Identity,
  buildFireflyReviewPacketV2,
  fireflyApplicationBindingSha256,
  resolveFireflyReviewCandidateV2,
  type FireflyReviewCandidateV2,
  type FireflyCanaryIsolationProjection,
  type FireflyReviewDecisionV2,
  type FireflyReviewPacketV2,
  type FireflyReviewPacketV2Body,
  type FireflySurfaceMatchV2,
} from "./storyyard/review-packet-v2.js";
export {
  BlindPairEvaluationTransferSchema,
  BlindPairPrivateMappingReceiptSchema,
  FireflyReviewEvaluationAckSchema,
  RefLabBlindPairEvaluationInputV2Schema,
  RefLabBlindPairEvaluatorInputV2Schema,
  RefLabBlindPairEvaluatorResultV2Schema,
  RefLabBlindReviewReceiptV2Schema,
  RefLabBlindSurfaceScanReceiptSchema,
  acknowledgeStoryyardEvaluation,
  blindPairMappingRelativePath,
  blindPairTransferRelativePath,
  materializeBlindPair,
  prepareBlindPair,
  storyyardEvaluationAckRelativePath,
  type BlindPairEvaluationTransfer,
  type BlindPairPrivateCandidateMapping,
  type BlindPairPrivateMappingReceipt,
  type FireflyReviewEvaluationAck,
  type MaterializeBlindPairInput,
  type MaterializeBlindPairResult,
  type PrepareBlindPairInput,
  type PrepareBlindPairResult,
  type RefLabBlindPairEvaluationInputV2,
  type RefLabBlindPairEvaluatorInputV2,
  type RefLabBlindPairEvaluatorResultV2,
  type RefLabBlindReviewReceiptV2,
  type RefLabBlindSurfaceScanReceipt,
} from "./storyyard/blind-pair-materialization.js";
export {
  FireflySurfaceProvenanceBridgeReceiptV1Schema,
  FireflySurfaceProvenanceInputV1Schema,
  assertFireflySurfaceProvenanceBridgeReceiptV1Identity,
  bridgeExactTokenSurfaceMatchV2,
  type FireflySurfaceProvenanceBridgeReceiptV1,
  type FireflySurfaceProvenanceInputV1,
} from "./storyyard/surface-selector-bridge.js";
export {
  type ArcStatus,
  type ArcEpisodeRole,
  type ArcEpisodeBeat,
  type FutureAdvantageMoveMode,
  type FutureAdvantageMove,
  type ArcPacket,
  type ActiveArc,
  ArcStatusSchema,
  ArcEpisodeRoleSchema,
  ArcEpisodeBeatSchema,
  FutureAdvantageMoveModeSchema,
  FutureAdvantageMoveSchema,
  ArcPacketSchema,
  ActiveArcSchema,
} from "./arc/schema.js";
export { ArcStore, assertSafeArcId, type ArcStoreOptions } from "./arc/store.js";
export {
  NarrativeArcAllocationInputSchema,
  NarrativeArcAllocationSchema,
  NarrativeArcAllocationStoreSchema,
  NarrativeArcGoldObligationInputSchema,
  NarrativeArcGoldObligationSchema,
  NarrativeArcGoldRouteSnapshotSchema,
  NarrativeArcObligationDispositionSchema,
  NarrativeArcPacketAssignmentInputSchema,
  NarrativeArcPacketAssignmentSchema,
  type NarrativeArcAllocation,
  type NarrativeArcAllocationInput,
  type NarrativeArcAllocationReview,
  type NarrativeArcAllocationStore,
  type NarrativeArcGoldObligation,
  type NarrativeArcGoldObligationInput,
  type NarrativeArcGoldRouteSnapshot,
  type NarrativeArcObligationDisposition,
  type NarrativeArcPacketAssignment,
  type NarrativeArcPacketAssignmentInput,
} from "./arc/allocation-schema.js";
export {
  NARRATIVE_ARC_ALLOCATION_STORE_PATH,
  approveNarrativeArcAllocation,
  assertNarrativeArcAllocationApproval,
  inspectNarrativeArcAllocation,
  loadNarrativeArcAllocationStore,
  saveNarrativeArcAllocationDraft,
  type ApproveNarrativeArcAllocationDeps,
  type NarrativeArcAllocationDeps,
  type NarrativeArcAllocationFreshness,
  type NarrativeArcAllocationInspection,
  type NarrativeArcGoldRouteInspection,
  type NarrativeArcPacketEvidenceInspection,
} from "./arc/allocation-store.js";
export {
  BookProductionArcPacketSnapshotSchema,
  BookProductionBaselineInputSchema,
  BookProductionBaselineReviewSchema,
  BookProductionBaselineSchema,
  BookProductionBaselineStoreSchema,
  BookProductionBookRulesSnapshotSchema,
  BookProductionGoldRouteSnapshotSchema,
  BookProductionNarrativeArcSnapshotSchema,
  BookProductionPitchSnapshotSchema,
  BookProductionStoryRailSnapshotSchema,
  type BookProductionArcPacketSnapshot,
  type BookProductionBaseline,
  type BookProductionBaselineInput,
  type BookProductionBaselineReview,
  type BookProductionBaselineStore,
  type BookProductionBookRulesSnapshot,
  type BookProductionGoldRouteSnapshot,
  type BookProductionNarrativeArcSnapshot,
  type BookProductionPitchSnapshot,
  type BookProductionStoryRailSnapshot,
} from "./production/baseline-schema.js";
export {
  BOOK_PRODUCTION_BASELINE_STORE_PATH,
  BOOK_PRODUCTION_PITCH_PATH,
  BOOK_PRODUCTION_RULES_PATH,
  approveBookProductionBaseline,
  assertBookProductionBaselineApproval,
  inspectBookProductionBaseline,
  loadBookProductionBaselineStore,
  saveBookProductionBaselineDraft,
  type BookProductionArcPacketInspection,
  type BookProductionBaselineDeps,
  type BookProductionBaselineFreshness,
  type BookProductionBaselineInspection,
  type BookProductionBookRulesInspection,
  type BookProductionGoldRouteInspection,
  type BookProductionNarrativeArcInspection,
  type BookProductionPitchInspection,
  type BookProductionStoryRailInspection,
} from "./production/baseline-store.js";
export {
  inspectBookProductionReadiness,
  type BookProductionAllocationStatus,
  type BookProductionChapterTruthStatus,
  type BookProductionGoldStatus,
  type BookProductionLiveFileStatus,
  type BookProductionOpenIssue,
  type BookProductionOwnerLockStatus,
  type BookProductionPacketStatus,
  type BookProductionRailStatus,
  type BookProductionReadinessReport,
  type BookProductionReadinessStatus,
  type BookProductionReferenceStatus,
  type InspectBookProductionReadinessDeps,
} from "./production/readiness-report.js";
export {
  type AnchorDetailLevel,
  type AnchorState,
  type StoryAnchor,
  type AnchorRail,
  type ArcActualEpisodeCount,
  type ArcRouteEntryStatus,
  type ArcRouteEntry,
  type ArcRouteCapacityReservation,
  type ArcRouteRail,
  type StoryRailReadiness,
  type StoryRailRouteCapacity,
  type StoryRailPlanInput,
  type StoryRailPlan,
  StableRailIdSchema,
  ArcActualEpisodeCountSchema,
  AnchorDetailLevelSchema,
  AnchorStateSchema,
  StoryAnchorSchema,
  AnchorRailSchema,
  ArcRouteEntryStatusSchema,
  ArcRouteEntrySchema,
  ArcRouteCapacityReservationSchema,
  ArcRouteRailSchema,
  StoryRailReadinessSchema,
  StoryRailRouteCapacitySchema,
  StoryRailPlanInputSchema,
  StoryRailPlanSchema,
  calculateStoryRailMaximumChapterCapacity,
} from "./arc/rail-schema.js";
export {
  StoryRailStore,
  type StoryRailStoreOptions,
  type BindActiveArcResult,
} from "./arc/rail-store.js";
export {
  type StoryRailReflowPending,
  type StoryRailReflowCloseout,
  type StoryRailDurableRevision,
  type StoryRailReflowDecision,
  type StoryRailReflowApplyInput,
  type StoryRailReflowDiscardInput,
  type StoryRailReflowDiscardReceipt,
  type StoryRailReflowReceipt,
  StoryRailReflowPendingSchema,
  StoryRailReflowCloseoutSchema,
  StoryRailDurableRevisionSchema,
  StoryRailReflowDecisionSchema,
  StoryRailReflowApplyInputSchema,
  StoryRailReflowDiscardInputSchema,
  StoryRailReflowDiscardReceiptSchema,
  StoryRailReflowReceiptSchema,
} from "./arc/reflow-schema.js";
export {
  StoryRailReflowStore,
  type StoryRailReflowStoreOptions,
  type StoryRailReflowNotEligibleReason,
  type StoryRailReflowPrepareResult,
  type StoryRailReflowApplyResult,
  type StoryRailReflowDiscardResult,
} from "./arc/reflow-store.js";
export {
  inspectStoryRailBinding,
  inspectStoryRailRuntimeEligibility,
  resolveActiveStoryRailProvenance,
  renderStoryRailProvenance,
  renderStoryRailPlan,
  type StoryRailBindingStatus,
  type StoryRailBindingInspection,
  type StoryRailRuntimeStatus,
  type StoryRailRuntimeInspection,
} from "./arc/rail-context.js";
export {
  createArcDraftFromForecast,
  loadOptionalActiveArcContext,
  renderChapterArcProvenance,
  renderArcContext,
  resolveArcChapterContext,
  type ArcChapterContext,
} from "./arc/forecast.js";
export { type LengthCountingMode, type LengthNormalizeMode, type LengthSpec, type LengthTelemetry, type LengthWarning, LengthCountingModeSchema, LengthNormalizeModeSchema, LengthSpecSchema, LengthTelemetrySchema, LengthWarningSchema } from "./models/length-governance.js";
export {
  type RuntimeStateLanguage,
  type StateManifest,
  type HookStatus,
  type HookRecord,
  type HooksState,
  type ChapterSummaryRow,
  type ChapterSummariesState,
  type CurrentStateFact,
  type CurrentStateState,
  type CurrentStatePatch,
  type HookOps,
  type NewHookCandidate,
  type RuntimeStateDelta,
  RuntimeStateLanguageSchema,
  StateManifestSchema,
  HookStatusSchema,
  HookRecordSchema,
  HooksStateSchema,
  ChapterSummaryRowSchema,
  ChapterSummariesStateSchema,
  CurrentStateFactSchema,
  CurrentStateStateSchema,
  CurrentStatePatchSchema,
  HookOpsSchema,
  NewHookCandidateSchema,
  RuntimeStateDeltaSchema,
} from "./models/runtime-state.js";
export {
  ChapterTruthReceiptSchema,
  chapterTruthReceiptRelativePath,
  hashLiveStoryStateProjection,
  verifyChapterTruthReceipt,
  writeChapterTruthReceipt,
  type ChapterTruthReceipt,
  type VerifiedChapterTruthReceipt,
} from "./state/chapter-truth-receipt.js";
export {
  FutureAdvantageExecutionCandidateSchema,
  ChapterFutureAdvantageExecutionSchema,
  FutureAdvantageCanonLedgerSchema,
  FutureAdvantageResearchReceiptStoreSchema,
  hashFutureAdvantageChapterContent,
  validateFutureAdvantageExecutionCandidate,
  type FutureAdvantageExecutionCandidate,
  type ChapterFutureAdvantageExecution,
  type FutureAdvantageCanonEntry,
  type FutureAdvantageCanonLedger,
  type FutureAdvantageResearchReceiptStore,
} from "./models/future-advantage-ledger.js";
export {
  FUTURE_ADVANTAGE_CANON_PATH,
  FUTURE_ADVANTAGE_RESEARCH_RECEIPTS_PATH,
  buildChapterFutureAdvantageExecution,
  rebuildApprovedFutureAdvantageCanon,
} from "./state/future-advantage-ledger.js";
export {
  type PlayActionKind,
  type PlayActionIntentInput,
  type PlayActionIntent,
  type PlayEntityType,
  type PlayEntityInput,
  type PlayEntity,
  type PlayVisibility,
  type PlayEdgeInput,
  type PlayEdge,
  type PlayStateSlotKind,
  type PlayStateSlotInput,
  type PlayStateSlot,
  type PlayEvidenceStatus,
  type PlayEvidenceTransitionInput,
  type PlayEvidenceTransition,
  type PlayEventInput,
  type PlayEvent,
  type PlayMutationInput,
  type PlayMutation,
  PlayActionKindSchema,
  PlayActionIntentSchema,
  PlayEntityTypeSchema,
  PlayEntitySchema,
  PlayVisibilitySchema,
  PlayEdgeSchema,
  PlayStateSlotKindSchema,
  PlayStateSlotSchema,
  PlayEvidenceStatusSchema,
  PlayEvidenceTransitionSchema,
  PlayEventSchema,
  PlayMutationSchema,
} from "./models/play.js";
export {
  PlayActionInterpreterAgent,
  PlayWorldMutatorAgent,
  PlaySceneRendererAgent,
  PlaySceneReconcilerAgent,
  type PlayActionInterpreterInput,
  type PlayWorldMutatorInput,
  type PlaySceneRenderInput,
  type PlaySceneReconcileInput,
  type PlaySceneRender,
} from "./play/play-agents.js";
export { PlayDB } from "./play/play-db.js";
export { createPlayDB, type PlayGraphDB } from "./play/play-db-factory.js";
export { PlayFileDB, type PlayGraphSnapshot } from "./play/play-file-db.js";
export {
  applyPlayMutation,
  type PlayReducerDB,
  type ApplyPlayMutationInput,
  type ApplyPlayMutationResult,
} from "./play/play-reducer.js";
export {
  PlayRunner,
  type PlayActionInterpreterLike,
  type PlayWorldMutatorLike,
  type PlaySceneRendererLike,
  type PlayRunnerOptions,
  type PlayStepResult,
} from "./play/play-runner.js";
export { PlayStore, type PlayTranscriptTurn, type PlayWorld, type PlayWorldInput, type PlayRunSummary } from "./play/play-store.js";
export {
  buildPlayEntityImagePrompt,
  buildPlaySceneImagePrompt,
  readPlayImageManifest,
  setPlayImageEntry,
  playImageFileName,
  generatePlayImage,
  readPlayImageSettings,
  writePlayImageSettings,
  DEFAULT_PLAY_IMAGE_SETTINGS,
  type PlayImageEntry,
  type PlayImageManifest,
  type PlayImageSettings,
} from "./play/play-image.js";
export {
  type ChapterMemo,
  type ChapterIntent,
  type ContextSource,
  type ContextPackage,
  type RuleLayerScope,
  type RuleLayer,
  type OverrideEdge,
  type ActiveOverride,
  type RuleStackSections,
  type VerifiedBookRuleRef,
  type RuleStack,
  type ChapterTrace,
  ChapterMemoSchema,
  ChapterIntentSchema,
  ContextSourceSchema,
  ContextPackageSchema,
  RuleLayerScopeSchema,
  RuleLayerSchema,
  OverrideEdgeSchema,
  ActiveOverrideSchema,
  RuleStackSectionsSchema,
  VerifiedBookRuleRefSchema,
  RuleStackSchema,
  ChapterTraceSchema,
} from "./models/input-governance.js";
export {
  AgentSkillSchema,
  createSkillRegistry,
  loadAvailableAgentSkills,
  loadBuiltinAgentSkills,
  loadBuiltinSkillResource,
  loadConfiguredAgentSkills,
  loadExternalAgentSkills,
  parseAgentSkillDocument,
  type AgentSkill,
  type CreateSkillRegistryOptions,
  type ExternalSkillDiagnostic,
  type LoadConfiguredAgentSkillsInput,
  type LoadAvailableAgentSkillsResult,
  type LoadExternalAgentSkillsInput,
  type LoadExternalAgentSkillsResult,
  type ParseAgentSkillDocumentOptions,
  type SkillRegistry,
  type SkillResolutionInput,
  type SkillResolutionResult,
} from "./skills/index.js";
export {
  BUILTIN_PROMPTS,
  BUILTIN_PROMPT_PACKS,
  PromptPackManifestSchema,
  PromptPackPromptNotFoundError,
  getBuiltinPrompt,
  listBuiltinPromptPacks,
  listBuiltinPrompts,
  loadPromptPackPrompt,
  promptOverridePath,
  type BuiltinPrompt,
  type LoadedPromptPackPrompt,
  type LoadPromptPackPromptInput,
  type PromptPackManifest,
  type PromptSource,
} from "./prompts/index.js";
export { PlannerAgent, type PlanChapterInput, type PlanChapterOutput } from "./agents/planner.js";
export {
  ComposerAgent,
  composeGovernedChapter,
  type ComposeChapterInput,
  type ComposeChapterOutput,
  type BookReferenceContextProvider,
} from "./agents/composer.js";
export {
  bindBookReference,
  listBookReferences,
  loadBookReferenceManifest,
  loadMaterialAsset,
  unbindBookReference,
  type BindBookReferenceInput,
  type BookReferenceBinding,
  type BookReferenceList,
  type BookReferenceManifest,
  type ResolvedBookReference,
} from "./references/book-references.js";
export {
  GOLD_ROUTE_RECEIPT_STORE_PATH,
  GoldArtifactReferenceSchema,
  GoldRouteReceiptSchema,
  GoldRouteReceiptStoreSchema,
  GoldRouteRoleSchema,
  GoldRouteSelectionSchema,
  GoldRouteTargetKindSchema,
  GoldRouteTargetSchema,
  GoldSelectionKindSchema,
  approveGoldRouteReceipt,
  assertGoldRouteReceiptApproval,
  inspectGoldRouteReceipt,
  loadGoldRouteReceiptStore,
  type ApproveGoldRouteReceiptInput,
  type GoldArtifactFreshness,
  type GoldArtifactInspection,
  type GoldArtifactReference,
  type GoldRouteReceipt,
  type GoldRouteReceiptDeps,
  type GoldRouteReceiptInspection,
  type GoldRouteReceiptStore,
  type GoldRouteRole,
  type GoldRouteSelection,
  type GoldRouteTarget,
  type GoldRouteTargetKind,
  type GoldSelectionKind,
} from "./references/gold-route-receipt.js";
export {
  selectBookReferenceContext,
  type BookReferenceContextSelection,
  type BookReferenceSelectionTask,
  type ReferenceSectionCandidate,
  type ReferenceSectionSelectionRequest,
  type ReferenceSectionSelector,
} from "./references/reference-context.js";
export {
  PLANNER_MEMO_SYSTEM_PROMPT,
  PLANNER_MEMO_USER_TEMPLATE,
  buildPlannerUserMessage,
  buildGoldenOpeningGuidance,
  type PlannerUserMessageInput,
} from "./agents/planner-prompts.js";
export {
  gatherPlanningMaterials,
  type PlanningMaterials,
} from "./utils/planning-materials.js";
export {
  buildProxyFetchInit,
  fetchWithProxy,
  resolveProxyUrl,
} from "./utils/proxy-fetch.js";
export { assertSafeBookId, deriveBookIdFromTitle, isSafeBookId } from "./utils/book-id.js";
export { safeChildPath, safeNonSymlinkChildPath } from "./utils/path-safety.js";
export { toPosixPath } from "./utils/posix-path.js";
export {
  AutomationModeSchema,
  type AutomationMode,
  normalizeAutomationMode,
} from "./interaction/modes.js";
export {
  InteractionIntentTypeSchema,
  type InteractionIntentType,
  InteractionRequestSchema,
  type InteractionRequest,
} from "./interaction/intents.js";
export {
  ActionSourceSchema,
  ActionPayloadSchema,
  CreateBookActionPayloadSchema,
  GenerateCoverActionPayloadSchema,
  InteractiveFilmCreateActionPayloadSchema,
  PlayStartActionPayloadSchema,
  RequestedIntentSchema,
  SkillIdSchema,
  ScriptCreateActionPayloadSchema,
  ScriptTargetFormatSchema,
  ShortRunActionPayloadSchema,
  StoryboardCreateActionPayloadSchema,
  WriteNextActionPayloadSchema,
  type ActionSource,
  type ActionPayload,
  type RequestedIntent,
  normalizeActionSource,
  normalizeActionPayload,
  normalizeSkillIdList,
  normalizeRequestedIntent,
  normalizePlayMode,
  isExplicitWriteChapterCommand,
  isUsablePlayInitialScene,
  isWriteNextInstruction,
} from "./interaction/action-envelope.js";
export {
  ExecutionStatusSchema,
  ExecutionStateSchema,
  InteractionEventSchema,
  type ExecutionStatus,
  type ExecutionState,
  type InteractionEvent,
  isTerminalExecutionStatus,
} from "./interaction/events.js";
export {
  BookCreationDraftSchema,
  DraftRoundSchema,
  PendingDecisionSchema,
  InteractionMessageSchema,
  InteractionSessionSchema,
  type BookCreationDraft,
  type DraftRound,
  type PendingDecision,
  type InteractionMessage,
  type InteractionSession,
  bindActiveBook,
  clearCreationDraft,
  clearPendingDecision,
  updateAutomationMode,
  updateCreationDraft,
  appendInteractionMessage,
  appendInteractionEvent,
  BookSessionSchema,
  SessionKindSchema,
  PlayModeSchema,
  GlobalSessionSchema,
  type BookSession,
  type SessionKind,
  type PlayMode,
  type GlobalSession,
  createBookSession,
  appendBookSessionMessage,
} from "./interaction/session.js";
export {
  resolveProjectSessionPath,
  createProjectSession,
  loadProjectSession,
  persistProjectSession,
  resolveSessionActiveBook,
  loadGlobalSession,
  persistGlobalSession,
} from "./interaction/project-session-store.js";
export {
  loadBookSession,
  persistBookSession,
  listBookSessions,
  renameBookSession,
  deleteBookSession,
  migrateBookSession,
  createAndPersistBookSession,
  SessionAlreadyMigratedError,
  SessionBindingMismatchError,
} from "./interaction/book-session-store.js";
export {
  appendManualSessionMessages,
  appendTranscriptEvent,
  sessionsDir,
  readTranscriptEvents,
  readTranscriptEventsStrict,
  deriveTranscriptSessionBinding,
  validateStrictTranscriptEvents,
  TranscriptIntegrityError,
  nextTranscriptSeq,
  transcriptPath,
  legacyBookSessionPath,
} from "./interaction/session-transcript.js";
export type { TranscriptSessionBinding } from "./interaction/session-transcript.js";
export {
  cleanRestoredAgentMessages,
  committedMessageEvents,
  deriveBookSessionFromTranscript,
  restoreAgentMessagesFromTranscript,
} from "./interaction/session-transcript-restore.js";
export {
  MessageEventSchema,
  RequestCommittedEventSchema,
  RequestFailedEventSchema,
  RequestStartedEventSchema,
  SessionCreatedEventSchema,
  SessionMetadataUpdatedEventSchema,
  TranscriptEventSchema,
} from "./interaction/session-transcript-schema.js";
export type {
  TranscriptEvent,
  MessageEvent,
  RequestCommittedEvent,
  RequestFailedEvent,
  RequestStartedEvent,
  SessionCreatedEvent,
  SessionMetadataUpdatedEvent,
} from "./interaction/session-transcript-schema.js";
export { routeInteractionRequest } from "./interaction/request-router.js";
export {
  processProjectInteractionRequest,
} from "./interaction/project-control.js";
export { createInteractionToolsFromDeps } from "./interaction/project-tools.js";
export { buildExportArtifact, writeExportArtifact } from "./interaction/export-artifact.js";
export {
  normalizeTruthFileName,
  classifyTruthAuthority,
  type TruthAuthority,
} from "./interaction/truth-authority.js";
export {
  executeEditTransaction,
  planEditTransaction,
  type EditRequest,
  type EditExecutionDeps,
  type ExecutedEditTransaction,
  type PlannedEditTransaction,
} from "./interaction/edit-controller.js";
export {
  runInteractionRequest,
  type InteractionRuntimeTools,
  type InteractionRuntimeResult,
} from "./interaction/runtime.js";
export {
  parseDraftDirectives,
  createDirectiveStreamFilter,
  type ParsedDraftResponse,
} from "./interaction/draft-directive-parser.js";

export {
  SHORT_FICTION_DEFAULT_CHAPTERS,
  SHORT_FICTION_MIN_CHAPTERS,
  SHORT_FICTION_MAX_CHAPTERS,
  SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER,
  SHORT_FICTION_MIN_CHARS_PER_CHAPTER,
  SHORT_FICTION_MAX_CHARS_PER_CHAPTER,
  SHORT_FICTION_EN_DEFAULT_WORDS_PER_CHAPTER,
  SHORT_FICTION_EN_MIN_WORDS_PER_CHAPTER,
  SHORT_FICTION_EN_MAX_WORDS_PER_CHAPTER,
  ShortFictionOutlineAgent,
  ShortFictionOutlineReviewerAgent,
  ShortFictionOutlineReviserAgent,
  ShortFictionWriterAgent,
  ShortFictionDraftReviewerAgent,
  ShortFictionDraftReviserAgent,
  ShortFictionPackagingAgent,
  parseShortFictionBatchDraft,
  validateShortFictionDraftForFinal,
  renderShortFictionDraftMarkdown,
  type ShortFictionOutline,
  type ShortFictionBatchDraft,
  type ShortFictionChapter,
  type ShortFictionSalesPackage,
  type ShortFictionReference,
  type ShortFictionLanguage,
} from "./agents/short-fiction.js";
export {
  generateShortFictionCover,
  runShortFictionProduction,
  extractResponsesImageBase64,
  resolveCoverApiKey,
  type ShortFictionCoverOptions,
  type ShortFictionCoverResult,
  type ShortFictionRunOptions,
  type ShortFictionRunResult,
  type ShortFictionRunRuntimes,
} from "./pipeline/short-fiction-runner.js";

// Narrative forecast (issue #342): non-canonical multi-branch story projection
export {
  FORECAST_MIN_BRANCHES,
  FORECAST_MAX_BRANCHES,
  FORECAST_DEFAULT_BRANCHES,
  FORECAST_MIN_HORIZON,
  FORECAST_MAX_HORIZON,
  FORECAST_DEFAULT_HORIZON,
  NarrativeForecastSchema,
  ForecastGenerationEvidenceSchema,
  ForecastBranchSchema,
  parseForecastModelOutput,
  type NarrativeForecast,
  type ForecastGenerationEvidence,
  type ForecastBranch,
  type ForecastBeat,
  type ForecastRisk,
  type ForecastStatus,
  type ForecastModelOutput,
} from "./forecast/schema.js";
export { ForecastStore, assertSafeForecastId, type ForecastStoreOptions } from "./forecast/store.js";
export {
  buildForecastContext,
  computeContextFingerprint,
  renderForecastContextMarkdown,
  type ForecastContext,
  type ForecastContextSections,
} from "./forecast/context-builder.js";
export { NarrativeForecastAgent, type ForecastGenerationInput } from "./forecast/agent.js";
export { renderForecastComparisonMarkdown, renderSelectedBranchPlanMarkdown } from "./forecast/render.js";
export {
  createNarrativeForecast,
  getNarrativeForecast,
  selectNarrativeBranch,
  type CreateNarrativeForecastOptions,
  type GetNarrativeForecastOptions,
  type SelectNarrativeBranchOptions,
  type NarrativeForecastCreateResult,
  type NarrativeForecastGetResult,
  type NarrativeForecastSelectResult,
} from "./forecast/runner.js";

// Agent (pi-agent integration)
export * from "./agent/index.js";

// LLM
export { createLLMClient, chatCompletion, createStreamMonitor, PartialResponseError, type LLMClient, type LLMResponse, type LLMMessage, type StreamProgress, type OnStreamProgress } from "./llm/provider.js";
export {
  CODEX_SERVICE_ID,
  CODEX_DEFAULT_MODEL,
  CODEX_MAX_TOOL_ROUNDS,
  probeCodexCli,
  runCodexCliCompletion,
  buildCodexCliPrompt,
  buildCodexChildEnvironment,
  parseCodexJsonl,
  type CodexCliStatus,
  type CodexCliResult,
} from "./llm/codex-cli.js";
export {
  SERVICE_PRESETS,
  SERVICE_TO_PI_PROVIDER,
  resolveServicePreset,
  resolveServiceProviderFamily,
  resolveServicePiProvider,
  resolveServiceModelsBaseUrl,
  guessServiceFromBaseUrl,
  listModelsForService,
  listServicesWithModelCount,
  type ServicePreset,
  type ModelInfo,
} from "./llm/service-presets.js";
export { resolveServiceModel, type ResolvedModel } from "./llm/service-resolver.js";
export { loadSecrets, saveSecrets, getServiceApiKey, type SecretsFile } from "./llm/secrets.js";
export {
  COVER_PROVIDER_PRESETS,
  coverSecretKey,
  normalizeCoverBaseUrl,
  resolveCoverProviderPreset,
  type CoverProviderId,
  type CoverProviderPreset,
} from "./llm/cover-providers.js";
export { migrateConfig, type MigrationResult } from "./llm/config-migration.js";
export { getAllEndpoints, getEndpoint, type InkosEndpoint, type InkosModel, type EndpointGroup } from "./llm/providers/index.js";
export { probeModelsFromUpstream, type ProbedModel } from "./llm/providers/probe.js";

// Agents
export { BaseAgent, type AgentContext } from "./agents/base.js";
export {
  ArchitectAgent,
  resolveFutureAdvantageFoundationMode,
  type ArchitectOutput,
  type FutureAdvantageFoundationMode,
} from "./agents/architect.js";
export { WriterAgent, type WriteChapterInput, type WriteChapterOutput, type TokenUsage } from "./agents/writer.js";
export { LengthNormalizerAgent, type NormalizeLengthInput, type NormalizeLengthOutput } from "./agents/length-normalizer.js";
export { ContinuityAuditor, type AuditResult, type AuditIssue } from "./agents/continuity.js";
export { ReviserAgent, DEFAULT_REVISE_MODE, type ReviseOutput, type ReviseMode } from "./agents/reviser.js";
export { PolisherAgent, type PolishChapterInput, type PolishChapterOutput } from "./agents/polisher.js";
export { RadarAgent, type RadarResult, type RadarRecommendation } from "./agents/radar.js";
export { FanqieRadarSource, QidianRadarSource, TextRadarSource, type RadarSource, type PlatformRankings, type RankingEntry } from "./agents/radar-source.js";
export { readGenreProfile, readGenreProfileWithReceipt, readBookRules, listAvailableGenres, getBuiltinGenresDir } from "./agents/rules-reader.js";
export {
  FICTION_CONTENT_CONTRACT_ID,
  FICTION_CONTENT_CONTRACT,
  FICTION_CONTENT_CONTRACT_SHA256,
  ContentIntensityAuthoritySchema,
  ContentIntensityDirectiveSchema,
  defaultContentIntensityDirective,
  loadContentIntensityDirective,
  appendFictionContentContract,
  hashCanonicalJson,
  prepareFictionContentInvocation,
  writeFictionContentInvocationOutcome,
  verifyFictionContentInvocationReceipts,
  readProductionModelCallReadback,
} from "./production/fiction-content-contract.js";
export type {
  ContentIntensityDirective,
  FictionContentInvocationTrace,
  FictionContentInvocationReceipt,
  FictionContentInvocationOutcome,
  PreparedFictionContentInvocation,
  FictionContentReceiptAudit,
  ProductionModelCallReadback,
} from "./production/fiction-content-contract.js";
export {
  createDetachedOwnerDirectionLease,
  resolveDetachedOwnerDirectionLease,
  cleanupExpiredDetachedPayloadLeases,
} from "./production/detached-payload-store.js";
export {
  directionTextSha256,
  verifyResolvedProductionDirectionContext,
  OwnerDirectionReferenceSchema,
  HermesControlTaskGuidanceReferenceSchema,
  ModelMediatedTaskGuidanceReferenceSchema,
  TaskGuidanceReferenceSchema,
  ResolvedProductionDirectionContextSchema,
  type OwnerDirectionReference,
  type HermesControlTaskGuidanceReference,
  type ModelMediatedTaskGuidanceReference,
  type TaskGuidanceReference,
  type ResolvedOwnerDirection,
  type ResolvedHermesControlTaskGuidance,
  type ResolvedModelMediatedTaskGuidance,
  type ResolvedTaskGuidance,
  type ResolvedProductionDirectionContext,
} from "./production/direction-context.js";
export {
  resolveHermesControlTaskGuidance,
  resolveModelMediatedTaskGuidance,
  resolveTaskGuidance,
} from "./production/task-guidance-resolver.js";
export {
  HermesControlActionSchema,
  HermesInvocationReceiptSchema,
  HermesControlImportReceiptV1Schema,
  HermesControlImportReceiptV2Schema,
  HermesControlImportReceiptSchema,
  AgentOperationTerminalReceiptV1Schema,
  AgentOperationTerminalReceiptV2Schema,
  AgentOperationTerminalReceiptSchema,
  hermesControlOperationPaths,
  importHermesControlOperation,
  loadAgentOperationTerminal,
  finalizeAgentOperation,
  type HermesControlAction,
  type HermesInvocationReceipt,
  type HermesControlArtifactRef,
  type HermesControlImportReceiptV1,
  type HermesControlImportReceiptV2,
  type HermesControlImportReceipt,
  type AgentOperationTerminalReceiptV1,
  type AgentOperationTerminalReceiptV2,
  type AgentOperationTerminalReceipt,
} from "./production/hermes-control-operation.js";
export {
  ProductionAttemptIdentitySchema,
  createProductionAttemptIdentity,
  verifyProductionAttemptIdentity,
  type ProductionAttemptIdentity,
} from "./production/attempt-identity.js";
export {
  ProductionCommandSourceSchema,
  ProductionCommandBindingSchema,
  ProductionTargetLengthSchema,
  ProductionCommandSchema,
  ProductionCommandV1Schema,
  ProductionCommandV2Schema,
  ProductionCommandAuthorizationV2Schema,
  isProductionCommandActionAuthorized,
  productionIntentDigest,
  createWriteNextProductionCommand,
  createWriteNextProductionCommandV2,
  productionCommandActionSource,
  parsePersistedProductionCommand,
  type ProductionCommandSource,
  type ProductionCommandBinding,
  type ProductionTargetLength,
  type ProductionCommand,
  type ProductionCommandV1,
  type ProductionCommandV2,
  type ProductionCommandAuthorizationV2,
  type ProductionAuthorizationEvidenceV2,
} from "./production/production-command.js";
export {
  ProductionExecutionContextSchema,
  runWithProductionExecutionContext,
  currentProductionExecutionContext,
  requireProductionExecutionContext,
  type ProductionExecutionContext,
} from "./production/execution-context.js";
export {
  ProductionRunSnapshotSchema,
  ProductionRunSchema,
  createProductionRunSnapshot,
  saveProductionRunSnapshot,
  loadProductionRunSnapshotByCommandId,
  loadProductionRunByCommandId,
  findProductionProjectionByIdempotencyKey,
  finalizeProductionRun,
  verifyProductionCommitEvidence,
  verifyProductionNoCommit,
  buildSucceededProductionRun,
  buildNoCommitProductionRun,
  type ProductionArtifactRef,
  type ProjectedChapterResult,
  type ProductionRunSnapshot,
  type ProductionRun,
} from "./production/run-projection.js";
export {
  executeObserveOnlyWriteNext,
  reconcileProductionRunSnapshot,
  ProductionExecutionTerminalError,
  type ProductionKernelWriteNextResult,
} from "./production/production-kernel.js";
export {
  SoulLifecycleSchema,
  SoulResourceRefSchema,
  SoulPackageManifestSchema,
  SoulEvidenceArtifactRefSchema,
  SoulAdoptionEvidenceSchema,
  SoulBindingDecisionReceiptV1Schema,
  SoulBindingDecisionReceiptV2Schema,
  SoulBindingDecisionReceiptSchema,
  BookSoulBindingV1Schema,
  BookSoulBindingV2Schema,
  BookSoulBindingSchema,
  ActiveSoulPointerSchema,
  SessionSoulBindingSchema,
  type SoulLifecycle,
  type SoulResourceRef,
  type SoulPackageManifest,
  type SoulEvidenceArtifactRef,
  type SoulAdoptionEvidence,
  type SoulBindingDecisionReceipt,
  type BookSoulBinding,
  type ActiveSoulPointer,
  type SessionSoulBinding,
} from "./production/soul-schema.js";
export {
  BookSoulStore,
  bindBookSoul,
  loadActiveBookSoulBinding,
  loadActiveBookSoulSessionBinding,
  sessionSoulBinding,
  sessionSoulBindingsEqual,
  type BindBookSoulInput,
  type ResolvedBookSoulInput,
} from "./production/book-soul-binding.js";
export {
  CANARY_ISOLATION_RECEIPT_MAX_BYTES,
  CanaryCommonSnapshotReceiptSchema,
  ProductionCanaryExecutionRootVerificationSchema,
  parseCanaryCommonSnapshotReceiptBytes,
  prepareProductionCanaryPair,
  loadCanaryCommonSnapshotReceipt,
  verifyProductionCanaryExecutionRoot,
  verifyProductionCanaryStructuralRoot,
  collectProductionCanaryFinalLaneManifestSha256,
  verifyProductionCanaryTerminalReplayRoot,
  acquireProductionCanaryAgentOperationLease,
  type CanaryCommonSnapshotReceipt,
  type CanaryRegularFileRef,
  type CanaryEvidenceRoots,
  type CanaryRelativeArtifactInput,
  type PrepareProductionCanaryPairInput,
  type PrepareProductionCanaryPairResult,
  type VerifyProductionCanaryExecutionRootInput,
  type VerifyProductionCanaryTerminalReplayRootInput,
  type ProductionCanaryExecutionRootVerification,
} from "./production/canary-isolation.js";
export {
  ProductionCanaryCommonContextSchema,
  materializeProductionCanaryCommonContext,
  type ProductionCanaryCommonContext,
  type MaterializeProductionCanaryCommonContextInput,
  type MaterializeProductionCanaryCommonContextResult,
} from "./production/canary-common-context.js";
export {
  ProductionInputFileReceiptSchema,
  ProductionSkillReceiptSchema,
  ProductionSoulInputReceiptSchema,
  ProductionInputReceiptSchema,
  createProductionInputReceipt,
  runWithProductionInputBundle,
  currentProductionInputBundle,
  assertCurrentProductionGenreProfileReceipt,
  appendProductionInput,
  sha256Bytes,
  type ProductionInputFileReceipt,
  type ProductionSkillReceipt,
  type ProductionSoulInputReceipt,
  type ProductionInputReceipt,
  type ProductionInputBundle,
} from "./production/production-input.js";
export {
  WRITE_NEXT_PRODUCTION_SKILL_POLICY,
  resolveWriteNextProductionSkills,
  type ProductionSkillPolicy,
  type ResolveProductionSkillsInput,
  type ResolvedProductionSkills,
} from "./production/production-skill.js";
export { buildWriterSystemPrompt, buildGoldenOpeningDiscipline } from "./agents/writer-prompts.js";
export { analyzeAITells, type AITellResult, type AITellIssue } from "./agents/ai-tells.js";
export {
  analyzeSensitiveWords,
  type PublicationCompatibilityIssue,
  type SensitiveWordResult,
  type SensitiveWordMatch,
} from "./agents/sensitive-words.js";
export { detectAIContent, type DetectionResult } from "./agents/detector.js";
export { analyzeStyle } from "./agents/style-analyzer.js";
export { analyzeDetectionInsights } from "./agents/detection-insights.js";
export { validatePostWrite, detectParagraphLengthDrift, detectParagraphShapeWarnings, detectDuplicateTitle, type PostWriteViolation } from "./agents/post-write-validator.js";
export { ChapterAnalyzerAgent, type AnalyzeChapterInput, type AnalyzeChapterOutput } from "./agents/chapter-analyzer.js";
export { parseWriterOutput, parseCreativeOutput, type ParsedWriterOutput, type CreativeOutput } from "./agents/writer-parser.js";
export { buildSettlerSystemPrompt, buildSettlerUserPrompt } from "./agents/settler-prompts.js";
export { parseSettlementOutput, type SettlementOutput } from "./agents/settler-parser.js";
export { parseSettlerDeltaOutput, type SettlerDeltaOutput } from "./agents/settler-delta-parser.js";
export { FanficCanonImporter, type FanficCanonOutput } from "./agents/fanfic-canon-importer.js";
export { getFanficDimensionConfig, FANFIC_DIMENSIONS, type FanficDimensionConfig } from "./agents/fanfic-dimensions.js";
export { buildFanficCanonSection, buildCharacterVoiceProfiles, buildFanficModeInstructions } from "./agents/fanfic-prompt-sections.js";
export * from "./prompts/index.js";

// Utils
export { isNewLayoutBook, isBookFoundationComplete } from "./utils/outline-paths.js";
export { fetchUrl, searchWeb } from "./utils/web-search.js";
export {
  runResearchReport,
  type ResearchDepth,
  type ResearchInput,
  type ResearchPurpose,
  type ResearchReport,
} from "./agents/researcher.js";
export { filterHooks, filterSummaries, filterSubplots, filterEmotionalArcs, filterCharacterMatrix } from "./utils/context-filter.js";
export { extractPOVFromOutline, filterMatrixByPOV, filterHooksByPOV } from "./utils/pov-filter.js";
export { ConsolidatorAgent } from "./agents/consolidator.js";
export { MemoryDB, type Fact, type StoredSummary } from "./state/memory-db.js";
export { StateValidatorAgent } from "./agents/state-validator.js";
export { loadRuntimeStateSnapshot, buildRuntimeStateArtifacts, saveRuntimeStateSnapshot, loadNarrativeMemorySeed, loadSnapshotCurrentStateFacts, type RuntimeStateArtifacts, type NarrativeMemorySeed } from "./state/runtime-state-store.js";
export { splitChapters, type SplitChapter } from "./utils/chapter-splitter.js";
export * from "./translation/index.js";
export { countChapterLength, resolveLengthCountingMode, formatLengthCount, buildLengthSpec, defaultChapterLength, DEFAULT_CHAPTER_LENGTH_ZH, DEFAULT_CHAPTER_LENGTH_EN, isOutsideSoftRange, isOutsideHardRange, chooseNormalizeMode, type LengthLanguage } from "./utils/length-metrics.js";
export { createLogger, createStderrSink, createJsonLineSink, nullSink, type Logger, type LogSink, type LogLevel, type LogEntry } from "./utils/logger.js";
export { inferLanguage, type WritingLanguage } from "./utils/language.js";
export { loadProjectConfig, GLOBAL_CONFIG_DIR, GLOBAL_ENV_PATH, isApiKeyOptionalForEndpoint } from "./utils/config-loader.js";
export {
  readResearchProjectSettings,
  type ResearchProjectLanguage,
  type ResearchProjectSettings,
} from "./utils/research-project-settings.js";
export { resolveEffectiveLLMConfig, type EffectiveLLMConfigResult, type EffectiveLLMDiagnostics, type LLMConfigCliOverrides, type LLMConfigMode, type LLMConsumer, type LLMValueSource } from "./utils/effective-llm-config.js";
export { loadLLMEnvLayers, mergeEnvMaps, studioIgnoredEnv, cliOverlayEnv, legacyEnv, type LLMEnvLayers, type LLMEnvMap } from "./utils/llm-env.js";
export type { ContextCompressionCallback, ContextCompressionCategory, ContextCompressionEvent, ContextCompressionPhase } from "./models/context-compression.js";
export { computeAnalytics, type AnalyticsData, type TokenStats } from "./utils/analytics.js";
export {
  evaluateBookQuality,
  computeChapterEvalScore,
  type BookEval,
  type ChapterEval,
  type EvaluateBookQualityOptions,
} from "./utils/book-eval.js";
export {
  collectStaleHookDebt,
  evaluateHookAdmission,
  classifyHookDisposition,
  type HookAdmissionCandidate,
  type HookAdmissionDecision,
  type HookDisposition,
} from "./utils/hook-governance.js";
export { arbitrateRuntimeStateDeltaHooks, type HookArbiterDecision } from "./utils/hook-arbiter.js";
export { analyzeHookHealth } from "./utils/hook-health.js";

// Pipeline
export { PipelineRunner, StoryRailProductionGateError, type PipelineConfig, type ChapterPipelineResult, type SurfaceWriteNextInput, type ReferenceHilApplyResult, type WriteChaptersOptions, type DraftResult, type PlanChapterResult, type ComposeChapterResult, type ReviseResult, type TruthFiles, type BookStatusInfo, type ImportChaptersInput, type ImportChaptersResult, type TokenUsageSummary } from "./pipeline/runner.js";
export { Scheduler, type SchedulerConfig } from "./pipeline/scheduler.js";
export { detectChapter, detectAndRewrite, loadDetectionHistory, type DetectChapterResult, type DetectAndRewriteResult } from "./pipeline/detection-runner.js";
export { runScriptCreation, runStoryboardCreation, runInteractiveFilmCreation, createStoryboardAssetsManifest, type ScriptCreationRunOptions, type ScriptCreationRunResult, type StoryboardAssetsManifest, type StoryboardCreationRunOptions, type StoryboardCreationRunResult, type InteractiveFilmCreationRunOptions, type InteractiveFilmCreationRunResult, type StoryboardImageAsset, type StoryboardImageAssetVariant } from "./pipeline/script-storyboard-runner.js";
export { ScriptCreationAgent, StoryboardCreationAgent, InteractiveFilmCreationAgent, renderScriptSpec, renderStoryboardSpec, renderInteractiveFilmSpec, type ScriptCreationInput, type ScriptTargetFormat, type StoryboardCreationInput, type InteractiveFilmCreationInput } from "./agents/script-storyboard.js";

// State
export { BookWriteLockError, StateManager } from "./state/manager.js";
export { syncChapterWordCounts, type ChapterWordCountChange, type ChapterWordSyncDeps, type ChapterWordSyncResult } from "./state/chapter-word-sync.js";
export { deleteLatestChapter, type ChapterDeleteDeps, type DeleteLatestChapterOptions, type DeleteLatestChapterResult } from "./state/chapter-delete.js";
export {
  archiveChapterVersion,
  listChapterVersions,
  readChapterPlanDocument,
  readChapterUserBrief,
  readChapterVersion,
  readChapterVersionMetadata,
  saveChapterUserBrief,
  type ChapterVersion,
  type ChapterVersionMetadata,
  type ChapterVersionSource,
} from "./state/chapter-workspace.js";
export { loadChaptersFromPath, compareChapterSourceNames } from "./agent/chapter-import-source.js";
export { bootstrapStructuredStateFromMarkdown } from "./state/state-bootstrap.js";
export { renderCurrentStateProjection, renderHooksProjection, renderChapterSummariesProjection } from "./state/state-projections.js";
export { applyRuntimeStateDelta, type RuntimeStateSnapshot } from "./state/state-reducer.js";
export { validateRuntimeState, type RuntimeStateValidationIssue } from "./state/state-validator.js";

// Notify
export { dispatchNotification, dispatchWebhookEvent, type NotifyMessage } from "./notify/dispatcher.js";
export type { NotifyFormat } from "./notify/format.js";
export type { TelegramConfig } from "./notify/telegram.js";
export type { FeishuConfig } from "./notify/feishu.js";
export type { WechatWorkConfig } from "./notify/wechat-work.js";
export type { WebhookConfig, WebhookEvent, WebhookPayload } from "./notify/webhook.js";

export async function sendTelegram(
  config: import("./notify/telegram.js").TelegramConfig,
  message: string,
  format?: import("./notify/format.js").NotifyFormat,
): Promise<void> {
  const transport = await import("./notify/telegram.js");
  await transport.sendTelegram(config, message, format);
}

export async function sendFeishu(
  config: import("./notify/feishu.js").FeishuConfig,
  title: string,
  text: string,
  format?: import("./notify/format.js").NotifyFormat,
): Promise<void> {
  const transport = await import("./notify/feishu.js");
  await transport.sendFeishu(config, title, text, format);
}

export async function sendWechatWork(
  config: import("./notify/wechat-work.js").WechatWorkConfig,
  text: string,
  format?: import("./notify/format.js").NotifyFormat,
): Promise<void> {
  const transport = await import("./notify/wechat-work.js");
  await transport.sendWechatWork(config, text, format);
}

export async function sendWebhook(
  config: import("./notify/webhook.js").WebhookConfig,
  payload: import("./notify/webhook.js").WebhookPayload,
): Promise<void> {
  const transport = await import("./notify/webhook.js");
  await transport.sendWebhook(config, payload);
}

// ── Interactive Film (story graph) ──
export {
  StoryGraphSchema,
  StoryNodeSchema,
  ChoiceSchema,
  VariableSchema,
  EndingSchema,
  ConditionSchema,
  EffectSchema,
  type StoryGraph,
  type StoryNode,
  type Choice,
  type Variable,
  type Ending,
  type Condition,
  type Effect,
  type VarValue,
  type NodeType,
} from "./interactive-film/graph-schema.js";
export {
  evaluateCondition,
  applyEffects,
  visibleChoices,
  initVarState,
  type VarState,
} from "./interactive-film/evaluator.js";
export {
  validateStoryGraph,
  reviewStoryGraph,
  type ValidationReport,
  type ValidationIssue,
} from "./interactive-film/validation.js";
export {
  loadStoryGraph,
  saveStoryGraph,
  storyGraphPath,
} from "./interactive-film/graph-store.js";
export {
  generateStoryGraph,
  buildStoryGraphFromLLMText,
  extractJson,
  type GenerateStoryGraphInput,
} from "./interactive-film/generate.js";
export {
  WorldAnchorSchema,
  CharacterSchema,
  VoiceProfileSchema,
  type WorldAnchor,
  type Character,
  type VoiceProfile,
} from "./interactive-film/graph-schema.js";
export {
  StoryGraphDeltaSchema,
  applyStoryGraphDelta,
  type StoryGraphDelta,
} from "./interactive-film/delta.js";
export {
  applyGraphDelta,
  loadAuthoringState,
  revertToSnapshot,
  authoringStatePath,
  type AuthoringState,
} from "./interactive-film/authoring-store.js";
export {
  buildWorldAnchorDelta,
  buildAddVariableDelta,
  buildDefineEndingDelta,
  buildRemoveNodeDelta,
  buildConnectChoiceDelta,
  buildUpsertCharactersDelta,
} from "./interactive-film/authoring-tools.js";
export { writeCharacterFacts, readCharacterVoices } from "./interactive-film/memory-link.js";
export {
  buildFillNodeDeltaFromLLMText,
  buildStructureDeltaFromLLMText,
} from "./interactive-film/authoring-generate.js";
export { summarizeStoryGraph, buildFilmAuthoringContext } from "./interactive-film/film-context.js";
export {
  generateNodeImage,
  defaultNodeImageDeps,
  type NodeImageDeps,
} from "./interactive-film/node-image.js";
export {
  enumerateRuntimePaths,
  type RuntimePath,
} from "./interactive-film/paths.js";
export {
  emotionScore,
  nodeEmotion,
  analyzeEmotionalArcs,
  analyzePathDistribution,
} from "./interactive-film/emotion.js";
export { exportInk } from "./interactive-film/export-ink.js";
export { buildPlayableHtml } from "./interactive-film/export-html.js";
export { ingestMaterial, type IngestMaterialInput, type MaterialAsset } from "./materials/ingest.js";
export {
  BOOK_RULE_PROVENANCE_COLLECTIONS,
  BookRuleOwnerDecisionDraftSchema,
  BookRuleOwnerDecisionInputSchema,
  type BookRuleOwnerDecisionDraft,
  type BookRuleOwnerDecisionInput,
  type BookRuleProvenanceCollection,
} from "./models/book-rule-provenance.js";
