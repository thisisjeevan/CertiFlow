import type { Prisma, RevisionStatus } from '../generated/prisma/client.js';

export async function notifyWorkflow(
  tx: Prisma.TransactionClient,
  batch: { id: string; centreId: string },
  status: RevisionStatus,
  dedupeKey: string,
  createdAt: Date,
) {
  const owners = { role: 'TRAINING_CENTRE', centreId: batch.centreId } as const;
  const scopes: Record<RevisionStatus, Prisma.UserWhereInput> = {
    DRAFT: { OR: [] },
    DISTRICT_REVIEW: { role: 'DISTRICT_OFFICER', district: { centres: { some: { id: batch.centreId } } } },
    QUALITY_REVIEW: { OR: [owners, { role: 'QUALITY_REVIEWER' }] },
    STATE_REVIEW: { OR: [owners, { role: 'STATE_OFFICER' }] },
    RETURNED: owners,
    REJECTED: owners,
    APPROVED: owners,
  };
  const recipients = await tx.user.findMany({ where: { AND: [{ active: true }, scopes[status]] }, select: { id: true } });
  if (!recipients.length) return;

  await tx.notification.createMany({
    data: recipients.map(({ id }) => ({
      userId: id, type: 'BATCH_' + status, resourceId: batch.id, dedupeKey, createdAt,
    })),
    skipDuplicates: true,
  });
}
