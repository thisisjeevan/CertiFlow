BEGIN;

-- Reviewers can still see revisions they already decided. Keep those views current.
CREATE FUNCTION certiflow_live_workflow(batch_id uuid, revision_id uuid, prior "RevisionStatus", current_status "RevisionStatus")
RETURNS void LANGUAGE sql AS $$
    SELECT certiflow_touch_live(
        'workflow:centre:' || b."centreId",
        CASE WHEN prior <> 'DRAFT' OR current_status <> 'DRAFT' THEN 'workflow:district:' || c."districtId" END,
        CASE WHEN prior = 'QUALITY_REVIEW' OR current_status = 'QUALITY_REVIEW' OR EXISTS (
            SELECT FROM "Decision" WHERE "revisionId" = revision_id AND stage = 'QUALITY'
        ) THEN 'workflow:quality' END,
        CASE WHEN prior = 'STATE_REVIEW' OR current_status = 'STATE_REVIEW' OR EXISTS (
            SELECT FROM "Decision" WHERE "revisionId" = revision_id AND stage = 'STATE'
        ) THEN 'workflow:state' END,
        CASE WHEN current_status = 'APPROVED' THEN 'certificates:centre:' || b."centreId" END,
        CASE WHEN current_status = 'APPROVED' THEN 'certificates:state' END
    )
    FROM "Batch" b JOIN "TrainingCentre" c ON c.id = b."centreId" WHERE b.id = batch_id;
$$;

CREATE OR REPLACE FUNCTION certiflow_live_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM certiflow_live_workflow(NEW."batchId", NEW.id, NULL, NEW.status);
    ELSIF OLD.status IS DISTINCT FROM NEW.status OR OLD."editVersion" IS DISTINCT FROM NEW."editVersion" THEN
        PERFORM certiflow_live_workflow(NEW."batchId", NEW.id, OLD.status, NEW.status);
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION certiflow_live_district_vote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- The first district approval changes counts without a revision transition.
    PERFORM certiflow_live_workflow(r."batchId", r.id, NULL, r.status) FROM "BatchRevision" r WHERE r.id = NEW."revisionId";
    RETURN NEW;
END;
$$;

DROP FUNCTION certiflow_live_workflow(uuid, "RevisionStatus", "RevisionStatus");

COMMIT;
