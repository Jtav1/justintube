import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";
import { JOB_KIND_VALUES, JOB_RUN_STATUS_VALUES } from "./constants.js";

/**
 * PROCESSING_JOB_RUNS table model. One row per `(originalUpload, jobKind,
 * paramsKey)` combination - the authoritative ledger of which processing
 * jobs have run (or are running) for which upload, with which parameters, so
 * callers can answer "do I need to (re)run this?" and "if it's already
 * running, what's its status?" without reconstructing that from BullMQ state
 * or from each job kind's own result table (FILE_VERSIONS, VIDEO_SUBTITLE,
 * ...). Updated in place across an upload's lifetime (not an attempt log) -
 * a re-enqueue overwrites the same row's `jobId`/`status` rather than
 * appending a new one, so a stale completion callback for a superseded
 * `jobId` naturally matches zero rows instead of clobbering a fresher
 * attempt (every status-update call site matches on `jobId`, not on the
 * `(originalUploadId, jobKind, paramsKey)` key).
 *
 * `paramsKey` is a short, deterministic string summarizing whichever
 * parameters apply to this job kind (`"profile:7"`, `"lang:en"`, `"ts:123"`,
 * `"default:true"`, or `"singleton"` for a kind with no distinguishing
 * parameter) - computed in `lib/processing-job-runs.js` rather than as a
 * generated SQL column, so it works identically on SQLite and MySQL. It
 * exists so a single `UNIQUE(original_upload_id, job_kind, params_key)`
 * index can enforce "at most one row per job identity" uniformly across
 * every job kind, including the no-extra-parameter ones - a composite
 * unique index directly on the nullable per-kind columns below wouldn't
 * work for those (SQL treats every `NULL` as distinct from every other
 * `NULL`, so it wouldn't catch a duplicate singleton row).
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const ProcessingJobRun = sequelize.define(
  "ProcessingJobRun",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    originalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    jobKind: constrainedString(JOB_KIND_VALUES, { allowNull: false }),
    // See the model-level doc comment above for why this exists and how it's
    // computed (lib/processing-job-runs.js's buildParamsKey).
    paramsKey: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    // BullMQ job id as of the most recent enqueue - not globally unique on
    // its own: a rendition/normalize/hash job reuses the same id across
    // retries, but a thumbnail/subtitle/hls/embed regeneration mints a fresh
    // one each time (see those jobs' own enqueue sites for why), which is
    // exactly the "fresher attempt" case the status-update matching above
    // depends on.
    jobId: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    status: constrainedString(JOB_RUN_STATUS_VALUES, {
      allowNull: false,
      defaultValue: "pending",
    }),
    // rendition only.
    transcodeProfileId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    // subtitle only - one row per extracted/attempted track's language
    // (empty string for an unlabeled track, matching VIDEO_SUBTITLE's own
    // convention).
    language: {
      type: DataTypes.STRING(35),
      allowNull: true,
    },
    // thumbnail only - requested timestamp in tenths-of-a-second, mirroring
    // ORIGINAL_UPLOADS.thumbnailTimestampTenths (null = processing picked
    // randomly, or used embedded art).
    thumbnailTimestampTenths: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    // embed only - whether this run used the placeholder asset vs. real art
    // (mirrors ORIGINAL_UPLOADS.embedVideoIsDefault).
    isDefaultThumbnail: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    // Set when status = "failed"; cleared on a fresh pending/complete.
    errorMessage: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "PROCESSING_JOB_RUNS",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["original_upload_id", "job_kind", "params_key"],
        name: "uq_processing_job_runs_key",
      },
      {
        fields: ["job_id"],
        name: "idx_processing_job_runs_job_id",
      },
    ],
  },
);
