import {
  pgTable,
  serial,
  bigint,
  text,
  date,
  boolean,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const jobPostings = pgTable('job_postings', {
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
});

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
