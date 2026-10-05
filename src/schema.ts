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
  },
  (table) => ({
    payUsdMonthIdx: index('idx_job_postings_pay_usd_month').on(table.payUsdMonth),
    processedIdx: index('idx_job_postings_is_processed').on(table.isProcessed),
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
