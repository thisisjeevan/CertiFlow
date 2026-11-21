import { submitDraft, type CentreOwner } from '../batches/service.js';
import type { Prisma } from '../generated/prisma/client.js';

const examples = [
  { id: '0f000000-0000-4000-8000-000000000201', prefix: 'ELECTRICAL', courseName: 'Electrical Safety', count: 3 },
  { id: '0f000000-0000-4000-8000-000000000202', prefix: 'DIGITAL', courseName: 'Digital Skills', count: 60 },
  { id: '0f000000-0000-4000-8000-000000000203', prefix: 'OVERDUE', courseName: 'Overdue Review Demo', count: 1, ageHours: 25 },
];

export async function seedReviewBatches(tx: Prisma.TransactionClient, owner: CentreOwner) {
  for (const example of examples) {
    if (await tx.batch.findUnique({ where: { id: example.id }, select: { id: true } })) continue;

    const submittedAt = new Date(Date.now() - (example.ageHours ?? 0) * 60 * 60 * 1_000);
    const revision = await tx.batchRevision.create({
      data: {
        batch: { create: { id: example.id, centreId: owner.centreId, courseName: example.courseName, createdAt: submittedAt } },
        revision: 1,
        createdAt: submittedAt,
        statusSince: submittedAt,
        createdBy: { connect: { id: owner.id } },
      },
    });
    const completions = await tx.trainingCompletion.createManyAndReturn({
      data: Array.from({ length: example.count }, (_, position) => {
        const reference = example.prefix + '-' + String(position + 1).padStart(2, '0');
        return {
          centreId: owner.centreId, courseName: example.courseName, reference: 'DEMO-' + reference,
          candidateReference: reference, completedOn: new Date('2025-04-01T00:00:00Z'), passed: true,
        };
      }),
      select: { id: true, candidateReference: true },
    });
    const candidates = await tx.candidate.createManyAndReturn({
      data: completions.map(({ id, candidateReference }) => ({
        reference: candidateReference, batchId: example.id, trainingCompletionId: id,
      })),
      select: { id: true, reference: true },
    });
    await tx.revisionCandidate.createMany({
      data: candidates.map(({ id, reference }) => {
        const number = Number(reference.slice(-2));
        return {
          revisionId: revision.id, batchId: example.id, candidateId: id,
          fullName: 'Demo Candidate ' + number, phoneE164: '+1202555' + String(99 + number).padStart(4, '0'),
        };
      }),
    });
    await submitDraft(tx, owner, example.id, revision.id + ':' + revision.editVersion, submittedAt);
  }
}
