import type { FictionContentOperationStart } from "../../production/fiction-content-contract.js";
import {
  prepareFictionContentInvocation,
  writeFictionContentInvocationOutcome,
} from "../../production/fiction-content-contract.js";

/**
 * Explicit Vitest fixture for tests that mock high-level agent methods and
 * therefore never reach BaseAgent. It creates ordinary, fully verified
 * contract evidence; it does not disable or bypass the production gate.
 */
export async function writeCompletedOperationEvidenceFixture(input: {
  readonly projectRoot: string;
  readonly operation: FictionContentOperationStart;
}): Promise<void> {
  for (const stage of input.operation.requiredStages) {
    const prepared = await prepareFictionContentInvocation({
      projectRoot: input.projectRoot,
      bookId: input.operation.bookId,
      agentName: `vitest-fixture-${stage}`,
      stage,
      model: "vitest-fixture",
      operationId: input.operation.operationId,
      messages: [
        { role: "system", content: `Explicit mocked-agent fixture for ${stage}.` },
        { role: "user", content: `Operation ${input.operation.operationKind}.` },
      ],
    });
    await writeFictionContentInvocationOutcome({
      projectRoot: input.projectRoot,
      prepared,
      output: `${stage} fixture completed`,
    });
  }
}
