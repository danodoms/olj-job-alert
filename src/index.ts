import 'dotenv/config';
import { startBot } from './bot';
import { startNotifier } from './notifier';
import { startScraper } from './scraper';
import { startStatus } from './status';

async function main(): Promise<void> {
  startBot();
  startScraper();
  startNotifier();
  await startStatus();
  console.log('[oljalerts] running');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});