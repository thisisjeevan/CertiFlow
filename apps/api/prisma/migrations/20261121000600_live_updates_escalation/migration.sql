CREATE TABLE "ReviewEscalation" (
    "id" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "stage" "ReviewStage" NOT NULL,
    "stageStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "thresholdHours" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewEscalation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReviewEscalation_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "BatchRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReviewEscalation_threshold_check"
      CHECK ("thresholdHours" > 0 AND "createdAt" > "stageStartedAt" + "thresholdHours" * interval '1 hour')
);
CREATE UNIQUE INDEX "ReviewEscalation_revisionId_stage_key" ON "ReviewEscalation"("revisionId", "stage");

ALTER TABLE "Notification" ADD COLUMN "escalationId" UUID;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_escalationId_fkey"
    FOREIGN KEY ("escalationId") REFERENCES "ReviewEscalation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Notification_escalationId_idx" ON "Notification"("escalationId");

CREATE TABLE "LiveVersion" (
    "scope" TEXT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    CONSTRAINT "LiveVersion_pkey" PRIMARY KEY ("scope")
);

-- Transactional per-scope counters have commit order and contain no resource data.
CREATE FUNCTION certiflow_touch_live(VARIADIC scopes text[]) RETURNS void LANGUAGE sql AS $$
    INSERT INTO "LiveVersion" ("scope")
    SELECT DISTINCT scope FROM unnest(scopes) AS entries(scope)
    WHERE scope IS NOT NULL ORDER BY scope
    ON CONFLICT ("scope") DO UPDATE SET "version" = "LiveVersion"."version" + 1;
$$;

CREATE FUNCTION certiflow_live_workflow(batch_id uuid, prior "RevisionStatus", current_status "RevisionStatus")
RETURNS void LANGUAGE sql AS $$
    SELECT certiflow_touch_live(
        'workflow:centre:' || b."centreId",
        CASE WHEN prior <> 'DRAFT' OR current_status <> 'DRAFT' THEN 'workflow:district:' || c."districtId" END,
        CASE WHEN prior = 'QUALITY_REVIEW' OR current_status = 'QUALITY_REVIEW' THEN 'workflow:quality' END,
        CASE WHEN prior = 'STATE_REVIEW' OR current_status = 'STATE_REVIEW' THEN 'workflow:state' END,
        CASE WHEN current_status = 'APPROVED' THEN 'certificates:centre:' || b."centreId" END,
        CASE WHEN current_status = 'APPROVED' THEN 'certificates:state' END
    )
    FROM "Batch" b JOIN "TrainingCentre" c ON c.id = b."centreId" WHERE b.id = batch_id;
$$;

CREATE FUNCTION certiflow_live_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM certiflow_live_workflow(NEW."batchId", NULL, NEW.status);
    ELSIF OLD.status IS DISTINCT FROM NEW.status OR OLD."editVersion" IS DISTINCT FROM NEW."editVersion" THEN
        PERFORM certiflow_live_workflow(NEW."batchId", OLD.status, NEW.status);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER certiflow_live_revision_trigger AFTER INSERT OR UPDATE ON "BatchRevision"
    FOR EACH ROW EXECUTE FUNCTION certiflow_live_revision();

CREATE FUNCTION certiflow_live_district_vote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- The first district approval changes counts without a revision transition.
    PERFORM certiflow_live_workflow(r."batchId", NULL, r.status) FROM "BatchRevision" r WHERE r.id = NEW."revisionId";
    RETURN NEW;
END;
$$;
CREATE TRIGGER certiflow_live_district_vote_trigger AFTER INSERT ON "Decision"
    FOR EACH ROW WHEN (NEW.stage = 'DISTRICT' AND NEW.outcome = 'APPROVE') EXECUTE FUNCTION certiflow_live_district_vote();

CREATE FUNCTION certiflow_live_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM certiflow_touch_live('notifications:' || NEW."userId");
    RETURN NEW;
END;
$$;
CREATE TRIGGER certiflow_live_notification_insert AFTER INSERT ON "Notification"
    FOR EACH ROW EXECUTE FUNCTION certiflow_live_notification();
CREATE TRIGGER certiflow_live_notification_read AFTER UPDATE OF "readAt" ON "Notification"
    FOR EACH ROW WHEN (OLD."readAt" IS DISTINCT FROM NEW."readAt") EXECUTE FUNCTION certiflow_live_notification();

CREATE FUNCTION certiflow_live_certificate(revision_id uuid) RETURNS void LANGUAGE sql AS $$
    SELECT certiflow_touch_live('certificates:centre:' || b."centreId", 'certificates:state')
    FROM "BatchRevision" r JOIN "Batch" b ON b.id = r."batchId" WHERE r.id = revision_id;
$$;

CREATE FUNCTION certiflow_live_certificate_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM certiflow_live_certificate(NEW."revisionId");
    RETURN NEW;
END;
$$;
CREATE TRIGGER certiflow_live_certificate_insert AFTER INSERT ON "Certificate"
    FOR EACH ROW EXECUTE FUNCTION certiflow_live_certificate_row();
CREATE TRIGGER certiflow_live_certificate_progress
    AFTER UPDATE OF "generationStatus", "generationAttempts", "revokedAt" ON "Certificate"
    FOR EACH ROW EXECUTE FUNCTION certiflow_live_certificate_row();

CREATE FUNCTION certiflow_live_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM certiflow_live_certificate(c."revisionId")
    FROM "Certificate" c WHERE c.id = NEW."certificateId";
    RETURN NEW;
END;
$$;
CREATE TRIGGER certiflow_live_delivery_progress AFTER UPDATE OF "status", "attempts", "providerReceipt" ON "MessageDelivery"
    FOR EACH ROW EXECUTE FUNCTION certiflow_live_delivery();
