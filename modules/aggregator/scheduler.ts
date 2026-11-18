import { aggregatorDb } from './database.js';
import { AggregatorService } from './aggregator.service.js';

class AggregatorScheduler {
  private pollTimer: NodeJS.Timeout | null = null;
  private alertTimer: NodeJS.Timeout | null = null;
  private pollRunning = false;
  private alertRunning = false;

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.runPollCycle();
    }, 60_000);
    this.alertTimer = setInterval(() => {
      void this.runAlertCycle();
    }, 60 * 60 * 1000);
    this.pollTimer.unref();
    this.alertTimer.unref();
    setTimeout(() => {
      void this.runPollCycle();
    }, 0).unref();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.alertTimer) clearInterval(this.alertTimer);
    this.pollTimer = null;
    this.alertTimer = null;
  }

  private async runPollCycle(): Promise<void> {
    if (this.pollRunning) return;
    this.pollRunning = true;
    try {
      const due = await aggregatorDb.query<{ id: number } & Record<string, unknown>>(
        `SELECT id FROM sources
         WHERE enabled = TRUE AND type <> 'manual'
           AND (last_run_at IS NULL
             OR last_run_at <= now() - poll_frequency_minutes * interval '1 minute')
         ORDER BY last_run_at NULLS FIRST, id`
      );
      for (const { id } of due.rows) {
        try {
          const result = await AggregatorService.runSource(id);
          console.info(`[aggregator] Source ${id}: fetched ${result.fetched}, inserted ${result.inserted}.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown source error.';
          console.error(`[aggregator] Source ${id} failed: ${message}`);
        }
      }
      await AggregatorService.publishAutoApproved();
    } catch (error) {
      console.error('[aggregator] Poll cycle failed:', error);
    } finally {
      this.pollRunning = false;
    }
  }

  private async runAlertCycle(): Promise<void> {
    if (this.alertRunning) return;
    this.alertRunning = true;
    try {
      await AggregatorService.checkAndSendAlerts();
    } catch (error) {
      console.error('[aggregator] Source-health alert cycle failed:', error);
    } finally {
      this.alertRunning = false;
    }
  }
}

export const aggregatorScheduler = new AggregatorScheduler();
