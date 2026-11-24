import {
  pgTable,
  serial,
  bigint,
  text,
  date,
  boolean,
  timestamp,
  numeric,
  real,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const jobPostings = pgTable(
  'job_postings',
  {
    id: serial('id').primaryKey(),
    jobId: bigint('job_id', { mode: 'number' }).notNull().unique(),
    jobTitle: text('job_title'),
    jobDescription: text('job_description'),
    jobSkills: text('job_skills'),
    typeOfWork: text('type_of_work'),
    compensation: text('compensation'),
    hoursPerWeek: text('hours_per_week'),
    jobDate: date('job_date'),
    isProcessed: boolean('is_processed').default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),

    // Normalized pay (see src/pay.ts).
    payMin: real('pay_min'),
    payMax: real('pay_max'),
    payCurrency: text('pay_currency'),
    payPeriod: text('pay_period'),
    payUnitLabel: text('pay_unit_label'),
    payUsdHour: real('pay_usd_hour'),
    payUsdMonth: real('pay_usd_month'),
    payConfidence: text('pay_confidence'),

    employer: text('employer'),
    employerId: bigint('employer_id', { mode: 'number' }),
    employerLogo: text('employer_logo'),
    descriptionHash: text('description_hash'),
    aiOverview: text('ai_overview'),
    aiAnalysis: jsonb('ai_analysis'),
    aiVersion: integer('ai_version'),
    aiUsage: jsonb('ai_usage'),
    aiEscalated: boolean('ai_escalated').default(false),
    aiAttempts: integer('ai_attempts').default(0),

    // Repost watch (see src/reposts.ts).
    repostOfJobId: bigint('repost_of_job_id', { mode: 'number' }),
    repostIds: jsonb('repost_ids').$type<number[]>(),
    repostScore: real('repost_score'),
    repostCount: integer('repost_count'),
    repostFirstSeen: timestamp('repost_first_seen', { withTimezone: true }),
    repostDiff: jsonb('repost_diff'),
    repostVersion: integer('repost_version'),
    repostCheckedAt: timestamp('repost_checked_at', { withTimezone: true }),
    repostAttempts: integer('repost_attempts').default(0),
  },
  (table) => ({
    payUsdMonthIdx: index('idx_job_postings_pay_usd_month').on(table.payUsdMonth),
    processedIdx: index('idx_job_postings_is_processed').on(table.isProcessed),
    hashIdx: index('idx_job_postings_description_hash').on(table.descriptionHash),
    employerIdx: index('idx_job_postings_employer_id').on(table.employerId),
    repostOfIdx: index('idx_job_postings_repost_of').on(table.repostOfJobId),
    employerCreatedIdx: index('idx_job_postings_employer_created').on(
      table.employerId,
      table.createdAt,
    ),
  }),
);

export const userSubscriptions = pgTable(
  'user_subscriptions',
  {
    id: serial('id').primaryKey(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    keyword: text('keyword').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniq: uniqueIndex('user_subscriptions_chat_id_keyword_unique').on(
      table.chatId,
      table.keyword,
    ),
  }),
);

/** Per-chat preferences. A missing row means every flag is off. */
export const userSettings = pgTable('user_settings', {
  chatId: bigint('chat_id', { mode: 'number' }).primaryKey(),
  aiOverview: boolean('ai_overview').notNull().default(false),
  resumeText: text('resume_text'),
  resumeHash: text('resume_hash'),
  resumeUpdatedAt: timestamp('resume_updated_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/** Cached overview+fit result per chat and job. Shared rows live in job_postings. */
export const jobFits = pgTable(
  'job_fits',
  {
    id: serial('id').primaryKey(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    jobId: bigint('job_id', { mode: 'number' }).notNull(),
    resumeHash: text('resume_hash').notNull(),
    fitVersion: integer('fit_version').notNull(),
    analysis: jsonb('analysis').notNull(),
    usage: jsonb('usage'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniq: uniqueIndex('job_fits_chat_id_job_id_unique').on(table.chatId, table.jobId),
    jobIdx: index('idx_job_fits_job_id').on(table.jobId),
  }),
);

/** Cached application kit per chat and job. Personal: never shared across chats. */
export const jobKits = pgTable(
  'job_kits',
  {
    id: serial('id').primaryKey(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    jobId: bigint('job_id', { mode: 'number' }).notNull(),
    resumeHash: text('resume_hash').notNull(),
    jobHash: text('job_hash').notNull(),
    kitVersion: integer('kit_version').notNull(),
    kit: jsonb('kit').notNull(),
    usage: jsonb('usage'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniq: uniqueIndex('job_kits_chat_id_job_id_unique').on(table.chatId, table.jobId),
    jobIdx: index('idx_job_kits_job_id').on(table.jobId),
    chatUpdatedIdx: index('idx_job_kits_chat_updated').on(table.chatId, table.updatedAt),
  }),
);

/** Cached OLJ employer search result, reused for 7 days. */
export const employerChecks = pgTable('employer_checks', {
  employerId: bigint('employer_id', { mode: 'number' }).primaryKey(),
  name: text('name'),
  paidActive: boolean('paid_active'),
  complaints: integer('complaints'),
  postCount: integer('post_count'),
  newPostCount: integer('new_post_count'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow(),
});

/** Per-chat feedback on a generated overview. Stored only, never displayed. */
export const overviewFeedback = pgTable(
  'overview_feedback',
  {
    id: serial('id').primaryKey(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    jobId: bigint('job_id', { mode: 'number' }).notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniq: uniqueIndex('overview_feedback_chat_id_job_id_key').on(table.chatId, table.jobId),
  }),
);

/** Telegram file_id of the rendered employer banner. Regenerated on logo change or TTL. */
export const employerBanners = pgTable('employer_banners', {
  employerId: bigint('employer_id', { mode: 'number' }).primaryKey(),
  fileId: text('file_id').notNull(),
  logoUrl: text('logo_url'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/** Log of alerts actually sent. Powers /mysubs insights and observability. */
export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    jobId: bigint('job_id', { mode: 'number' }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    chatIdx: index('idx_notifications_chat_id').on(table.chatId),
    chatSentIdx: index('idx_notifications_chat_sent').on(table.chatId, table.sentAt),
    chatJobUniq: uniqueIndex('notifications_chat_job_unique').on(table.chatId, table.jobId),
  }),
);
