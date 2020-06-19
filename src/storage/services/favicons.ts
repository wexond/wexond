import axios from 'axios';
import { fromBuffer } from 'file-type';
import * as sharp from 'sharp';

import DbService from './db';
import { WorkerMessengerFactory } from '~/common/worker-messenger-factory';
import { convertIcoToPng } from '../utils';
import { dateToChromeTime } from '~/common/utils/date';

class FaviconsService {
  public start() {
    const handler = WorkerMessengerFactory.createHandler('favicons', this);

    handler('getFavicon', this.getFavicon);
    handler('saveFavicon', this.saveFavicon);
  }

  private get db() {
    return DbService.favicons;
  }

  public getFavicon(pageUrl: string) {
    const data = this.db
      .prepare(
        `
      SELECT image_data
      FROM favicon_bitmaps
      INNER JOIN icon_mapping
        ON favicon_bitmaps.icon_id=icon_mapping.icon_id
      WHERE icon_mapping.page_url=@pageUrl AND favicon_bitmaps.width = 32 LIMIT 1
      `,
      )
      .get({ pageUrl });

    return data?.image_data;
  }

  private addIconMapping(iconId: number, pageUrl: string) {
    this.db
      .prepare(
        `INSERT INTO icon_mapping (page_url, icon_id) VALUES (@pageUrl, @iconId)`,
      )
      .run({ pageUrl, iconId });
  }

  public async saveFavicon(pageUrl: string, faviconUrl: string) {
    let iconId = this.db
      .prepare(`SELECT id FROM favicons WHERE url = @faviconUrl`)
      .get({ faviconUrl })?.id;

    if (iconId) {
      this.addIconMapping(iconId, pageUrl);
      return;
    }

    const res = await axios.get(faviconUrl, { responseType: 'arraybuffer' });
    const [image16, image32] = await this.processFavicon(res.data);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO favicons (url, icon_type) VALUES (@faviconUrl, 1)`,
        )
        .run({ faviconUrl });

      iconId = this.db.prepare(`SELECT last_insert_rowid() as id`).get().id;

      this.addIconMapping(iconId, pageUrl);

      const bitmapOptions = {
        iconId,
        lastUpdated: dateToChromeTime(new Date()),
      };

      const bitmapSql = this.db.prepare(
        `INSERT INTO favicon_bitmaps (icon_id, last_updated, image_data, width, height, last_requested) VALUES (@iconId, @lastUpdated, @imageData, @width, @height, 0)`,
      );

      bitmapSql.run({
        ...bitmapOptions,
        imageData: image16,
        width: 16,
        height: 16,
      });

      bitmapSql.run({
        ...bitmapOptions,
        imageData: image32,
        width: 32,
        height: 32,
      });
    })();
  }

  private async processFavicon(buffer: Buffer) {
    const type = await fromBuffer(buffer);

    if (type && type.ext === 'ico') {
      buffer = await convertIcoToPng(buffer);
    }

    const instance = sharp(buffer).png();

    const options: sharp.ResizeOptions = {
      withoutEnlargement: true,
    };

    return await Promise.all([
      instance.resize(16, 16, options).toBuffer(),
      instance.resize(32, 32, options).toBuffer(),
    ]);
  }
}

export default new FaviconsService();
