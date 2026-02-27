export class BaseParser {
  constructor({ timezone = 'Europe/Berlin' } = {}) {
    this.timezone = timezone;
  }

  parse() {
    throw new Error('parse() must be implemented by subclasses');
  }
}
