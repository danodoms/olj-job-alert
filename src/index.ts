import 'dotenv/config';
import { startBot } from './bot';
import { startNotifier } from './notifier';
import { startScraper } from './scraper';

function main(): void {
  startBot();
  startScraper();
  startNotifier();
  console.log('[oljalerts] running');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});