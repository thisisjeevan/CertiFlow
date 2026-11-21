import type { Prisma } from '../generated/prisma/client.js';
import type { Principal } from './session.js';

export function centreScope(principal: Principal): Prisma.TrainingCentreWhereInput {
  switch (principal.role) {
    case 'TRAINING_CENTRE':
      return principal.centreId ? { id: principal.centreId } : { OR: [] };
    case 'DISTRICT_OFFICER':
      return principal.districtId ? { districtId: principal.districtId } : { OR: [] };
    case 'QUALITY_REVIEWER':
    case 'STATE_OFFICER':
      return {};
    default:
      return { OR: [] };
  }
}
