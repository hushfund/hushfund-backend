export class RelayError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
