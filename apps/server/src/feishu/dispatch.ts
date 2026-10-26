/** Serializes all message and tool work per Thread Channel while allowing
 * independent channels to run concurrently. Duplicate durable jobs share the
 * same in-flight promise. */
export class FeishuChannelDispatcher {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly jobs = new Map<string, Promise<void>>()

  get activeChannels(): number { return this.tails.size }
  get activeJobs(): number { return this.jobs.size }
  has(jobId: string): boolean { return this.jobs.has(jobId) }

  enqueue(channelId: string, jobId: string, work: () => Promise<void>): Promise<void> {
    const existing = this.jobs.get(jobId)
    if (existing) return existing
    const previous = this.tails.get(channelId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(work)
    this.jobs.set(jobId, current)
    this.tails.set(channelId, current)
    const cleanup = () => {
      this.jobs.delete(jobId)
      if (this.tails.get(channelId) === current) this.tails.delete(channelId)
    }
    void current.then(cleanup, cleanup)
    return current
  }
}
