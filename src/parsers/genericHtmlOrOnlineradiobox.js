import { BaseParser } from './base.js';
import { OnlineradioboxParser } from './onlineradiobox.js';
import { GenericHtmlParser } from './genericHtml.js';

export class GenericHtmlOrOnlineradioboxParser extends BaseParser {
  parse(html, sourceUrl) {
    const onlineradiobox = new OnlineradioboxParser({ timezone: this.timezone });
    const result = onlineradiobox.parse(html, sourceUrl);
    if (result.length) return result;
    const generic = new GenericHtmlParser({ timezone: this.timezone });
    return generic.parse(html, sourceUrl);
  }
}
