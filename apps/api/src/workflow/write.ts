import { Prisma, type PrismaClient, type Role } from '../generated/prisma/client.js';
import { HttpError } from '../http.js';

type WorkflowActor = { id: string; role: Role; centreId: string | null; districtId: string | null };
type WorkflowCentre = { id: string; districtId: string };

export async function withWorkflowWrite<T>(
  db: PrismaClient, actorId: string, centreId: string,
  write: (tx: Prisma.TransactionClient, actor: WorkflowActor, centre: WorkflowCentre) => Promise<T>,
) {
  try {
    return await db.$transaction(async (tx) => {
      // Intake and review take the same lock before reading the current revision.
      const [centre] = await tx.$queryRaw<WorkflowCentre[]>`
        SELECT id, "districtId" FROM "TrainingCentre" WHERE id = ${centreId}::uuid FOR NO KEY UPDATE
      `;
      const [actor] = await tx.$queryRaw<WorkflowActor[]>`
        SELECT id, role, "centreId", "districtId" FROM "User"
        WHERE id = ${actorId}::uuid AND active FOR SHARE
      `;
      if (!centre || !actor) throw new HttpError(403, 'FORBIDDEN', 'This action is unavailable to your account.');
      return write(tx, actor, centre);
    }, { isolationLevel: 'ReadCommitted', timeout: 10_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError
      && (['P2028', 'P2034'].includes(error.code) || (error.code === 'P2010' && error.meta?.code === '57014'))) {
      throw new HttpError(409, 'WORKFLOW_BUSY', 'The workflow changed or is busy. Reload and try again.');
    }
    throw error;
  }
}
