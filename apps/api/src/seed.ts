import { Role } from './generated/prisma/client.js';
import { hashPassword } from './auth/password.js';
import { readSeedConfig } from './config.js';
import { connectDatabase } from './db.js';

const config = readSeedConfig();
const db = connectDatabase(config.DATABASE_URL);
const id = (value: number) => '0f000000-0000-4000-8000-' + String(value).padStart(12, '0');

async function seed() {
  const accounts = [
    { id: id(101), name: 'Anika', role: Role.TRAINING_CENTRE },
    { id: id(102), name: 'Dev', role: Role.DISTRICT_OFFICER },
    { id: id(103), name: 'Meera', role: Role.DISTRICT_OFFICER },
    { id: id(104), name: 'Kabir', role: Role.DISTRICT_OFFICER },
    { id: id(105), name: 'Neha', role: Role.QUALITY_REVIEWER },
    { id: id(106), name: 'Farah', role: Role.STATE_OFFICER },
  ];
  const credentials = await Promise.all(accounts.map(async (account) => ({
    ...account,
    email: account.name.toLowerCase() + '@demo.certiflow.test',
    passwordHash: await hashPassword(config.DEMO_PASSWORD),
  })));

  await db.$transaction(async (tx) => {
    const north = await tx.district.upsert({
      where: { code: 'NORTH' },
      update: { name: 'North District' },
      create: { id: id(1), code: 'NORTH', name: 'North District' },
    });
    const south = await tx.district.upsert({
      where: { code: 'SOUTH' },
      update: { name: 'South District' },
      create: { id: id(2), code: 'SOUTH', name: 'South District' },
    });
    const centres = [
      { id: id(11), code: 'N-01', name: 'Pragati Skills Centre', districtId: north.id },
      { id: id(12), code: 'N-02', name: 'North Technical Institute', districtId: north.id },
      { id: id(13), code: 'S-01', name: 'South Vocational Centre', districtId: south.id },
    ];
    let anikaCentreId = centres[0]!.id;
    for (const { id, code, name, districtId } of centres) {
      const centre = await tx.trainingCentre.upsert({
        where: { code },
        update: { name, districtId },
        create: { id, code, name, districtId },
      });
      if (code === 'N-01') anikaCentreId = centre.id;
    }

    for (const account of credentials) {
      const profile = {
        displayName: account.name,
        role: account.role,
        centreId: account.role === Role.TRAINING_CENTRE ? anikaCentreId : null,
        districtId: account.role === Role.DISTRICT_OFFICER ? north.id : null,
        passwordHash: account.passwordHash,
        active: true,
      };
      await tx.user.upsert({
        where: { email: account.email },
        update: profile,
        create: { ...profile, id: account.id, email: account.email },
      });
    }
  });

  console.info(JSON.stringify({ event: 'demo_seeded', accountCount: accounts.length }));
}

try {
  await seed();
} catch (error) {
  console.error(JSON.stringify({ event: 'seed_failed', error: error instanceof Error ? error.name : 'UnknownError' }));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
