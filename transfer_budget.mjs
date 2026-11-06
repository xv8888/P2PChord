export class TransferBudget {
  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Transfer limit must be a positive whole number.");
    }
    this.limit = limit;
    this.active = 0;
  }

  acquire() {
    if (this.active >= this.limit) {
      const error = new Error("Too many active source transfers");
      error.statusCode = 503;
      throw error;
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }

  getSnapshot() {
    return { active: this.active, limit: this.limit };
  }
}
