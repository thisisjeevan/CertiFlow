import { createHash, randomBytes } from 'node:crypto';
import { Role } from '../../src/generated/prisma/client.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { readApiConfig } from '../../src/config.js';
import { testDatabase } from './database.js';

const db = testDatabase();
const config = readApiConfig({
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://localhost:8080',
  DATABASE_URL: process.env.TEST_DATABASE_URL,
});
const app = createApp(config, db);
const password = randomBytes(24).toString('base64url');
const fixture = randomBytes(8).toString('hex');
const emails = {
  centre: 'centre-' + fixture + '@example.test',
  district: 'district-' + fixture + '@example.test',
  state: 'state-' + fixture + '@example.test',
  inactive: 'inactive-' + fixture + '@example.test',
};
const primaryCode = 'centre-' + fixture;
const peerCode = 'peer-' + fixture;
const outsideCode = 'outside-' + fixture;
let outsideId: string;

beforeAll(async () => {
  const passwordHash = await hashPassword(password);
  outsideId = await db.$transaction(async (tx) => {
    const north = await tx.district.create({ data: { code: 'north-' + fixture, name: 'Test North' } });
    const south = await tx.district.create({ data: { code: 'south-' + fixture, name: 'Test South' } });
    const primary = await tx.trainingCentre.create({
      data: { code: primaryCode, name: 'Primary', districtId: north.id },
    });
    await tx.trainingCentre.create({ data: { code: peerCode, name: 'Peer', districtId: north.id } });
    const outside = await tx.trainingCentre.create({
      data: { code: outsideCode, name: 'Outside', districtId: south.id },
    });
    await tx.user.createMany({ data: [
      { email: emails.centre, role: Role.TRAINING_CENTRE, centreId: primary.id, displayName: 'Centre', passwordHash },
      { email: emails.district, role: Role.DISTRICT_OFFICER, districtId: north.id, displayName: 'District', passwordHash },
      { email: emails.state, role: Role.STATE_OFFICER, displayName: 'State', passwordHash },
      { email: emails.inactive, role: Role.STATE_OFFICER, displayName: 'Inactive', passwordHash, active: false },
    ] });
    return outside.id;
  });
});

afterAll(async () => {
  await db.$transaction([
    db.user.deleteMany({ where: { email: { in: Object.values(emails) } } }),
    db.trainingCentre.deleteMany({ where: { code: { in: [primaryCode, peerCode, outsideCode] } } }),
    db.district.deleteMany({ where: { code: { in: ['north-' + fixture, 'south-' + fixture] } } }),
  ]).finally(() => db.$disconnect());
});

function signIn(email: string, candidatePassword = password) {
  return request(app).post('/api/auth/login').set('Origin', config.APP_ORIGIN)
    .send({ email, password: candidatePassword });
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }) {
  const values = response.headers['set-cookie'];
  if (!Array.isArray(values) || !values[0]) throw new Error('Session cookie missing');
  const value = values[0];
  return { value, pair: value.split(';', 1)[0]! };
}

describe('authentication with PostgreSQL', () => {
  it('reads readiness from a migrated database', async () => {
    await request(app).get('/health/ready').expect(200, { status: 'ready', database: 'up' });
  });

  it('stores only a token hash, rotates sessions, and invalidates logout', async () => {
    const login = await signIn(emails.centre.toUpperCase()).expect(200);
    const cookie = cookieFrom(login);
    expect(cookie.value).toMatch(/HttpOnly; SameSite=Lax/);
    expect(login.headers['cache-control']).toBe('no-store');
    expect(login.body.user).toMatchObject({ email: emails.centre, role: 'TRAINING_CENTRE' });
    expect(login.body.user).not.toHaveProperty('passwordHash');

    const token = cookie.pair.split('=')[1]!;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    expect(await db.session.findUnique({ where: { tokenHash } })).toMatchObject({ userId: login.body.user.id });
    await request(app).get('/api/auth/me').set('Cookie', cookie.pair).expect(200);

    const rotated = await request(app).post('/api/auth/login').set('Cookie', cookie.pair)
      .send({ email: emails.centre, password }).expect(200);
    const replacement = cookieFrom(rotated).pair;
    expect(replacement).not.toBe(cookie.pair);
    await request(app).get('/api/auth/me').set('Cookie', cookie.pair).expect(401);

    await request(app).post('/api/auth/logout').set('Cookie', replacement).send({}).expect(204);
    await request(app).get('/api/auth/me').set('Cookie', replacement).expect(401);
  });

  it('returns the same response for bad passwords, missing users, and inactive users', async () => {
    const wrong = await signIn(emails.centre, password + '!').expect(401);
    const absent = await signIn('missing-' + fixture + '@example.test').expect(401);
    const inactive = await signIn(emails.inactive).expect(401);
    expect(wrong.body).toEqual(absent.body);
    expect(inactive.body).toEqual(absent.body);
  });

  it('rejects expired sessions and rechecks account status for existing sessions', async () => {
    const expired = cookieFrom(await signIn(emails.centre).expect(200)).pair;
    const expiredHash = createHash('sha256').update(expired.split('=')[1]!).digest('hex');
    await db.session.update({
      where: { tokenHash: expiredHash }, data: { expiresAt: new Date(Date.now() - 1_000), createdAt: new Date(0) },
    });
    await request(app).get('/api/auth/me').set('Cookie', expired).expect(401);

    const active = await signIn(emails.state).expect(200);
    await db.user.update({ where: { email: emails.state }, data: { active: false } });
    try {
      await request(app).get('/api/auth/me').set('Cookie', cookieFrom(active).pair).expect(401);
    } finally {
      await db.user.update({ where: { email: emails.state }, data: { active: true } });
    }
  });
});

describe('authorization with PostgreSQL', () => {
  it('scopes list and detail by server-side role, centre, and district', async () => {
    const centre = cookieFrom(await signIn(emails.centre).expect(200)).pair;
    const district = cookieFrom(await signIn(emails.district).expect(200)).pair;
    const state = cookieFrom(await signIn(emails.state).expect(200)).pair;

    const scopedCentre = await request(app).get('/api/centres').set('Cookie', centre).expect(200);
    const scopedDistrict = await request(app).get('/api/centres').set('Cookie', district).expect(200);
    expect(scopedCentre.body.centres.map(({ code }: { code: string }) => code)).toEqual([primaryCode]);
    expect(scopedDistrict.body.centres.map(({ code }: { code: string }) => code)).toEqual([primaryCode, peerCode]);

    const peerId = scopedDistrict.body.centres.find(({ code }: { code: string }) => code === peerCode).id;
    await request(app).get('/api/centres/' + peerId).set('Cookie', centre).expect(404);
    await request(app).get('/api/centres/' + peerId).set('Cookie', district).expect(200);
    await request(app).get('/api/centres/' + outsideId).set('Cookie', district).expect(404);
    await request(app).get('/api/centres/' + outsideId).set('Cookie', state).expect(200);
  });
});
