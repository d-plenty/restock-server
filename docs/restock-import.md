# Importing products and prices (Restock server 0.9.6)

The Data tab on your Restock server's web page has **Import data**, below **Download your data**. It adds
products and their prices from a file to what is already on the server. It never replaces or deletes anything,
and it never adds to your shopping list or pantry. Prices you import are marked **imported**, so they stay apart
from the prices your phones checked.

It takes:

- the **Full export file (.json)** the Data tab downloads (from this server or another one), or
- the **CSV files (.zip)** the Data tab downloads (it reads `Products.csv` and `Prices.csv` from it), or
- a file you make yourself in the same shape (below).

Spreadsheets (.xlsx) can't be imported: save the CSV files or the JSON file instead.

Only import prices you're allowed to use. Shops' websites have terms of use, and some don't allow collecting
their prices with automated tools. Restock doesn't fetch shops for you here, and never imports Costco prices.

## How it goes

1. **Choose a file to import.** The page reads the file on your computer.
2. **Checking the file.** A dry run: nothing is added yet. It ends with a line like *"Will add 12,000 products
   and 90,000 prices, skip 300 already there, ignore 12 it couldn't read."* and says why anything was left out.
3. **Step 1 of 2:** what it will add. **Continue**, or **Cancel**.
4. **Step 2 of 2:** your passphrase again (as for deleting data). You need to be signed in with the passphrase,
   not with a phone.
5. **Importing.** It shows how far it is. **Cancel** stops after the part being sent: what went in stays, and
   importing the same file again skips what's already there.

## Making a file

A file is JSON with a format, a version, and a `products` table. Prices can go in a `prices` table (each with
the `product_id` of its product, as the export writes them), or inside each product as `prices`. Both are fine
in one file.

```json
{
  "format": "restock-export",
  "v": 1,
  "tables": {
    "products": [
      {
        "id": "ww-123456",
        "chain": "woolworths",
        "store_product_id": "123456",
        "name": "Woolworths Full Cream Milk 2L",
        "brand": "Woolworths",
        "size": "2L",
        "barcode": "9300633603205",
        "qty": 2000,
        "qty_unit": "ml",
        "prices": [
          { "date": "2026-11-03", "price": 3.1 },
          { "date": "2026-11-10T06:30:00+10:00", "price": 2.8, "is_special": true, "was_price": 3.1, "promo": "Save 30c" }
        ]
      },
      { "id": "aldi-choc", "chain": "aldi", "name": "Moser Roth dark chocolate 125g", "size": "125g" }
    ],
    "prices": [
      { "product_id": "aldi-choc", "date": "2026-11-09", "price": 2.29 }
    ]
  }
}
```

### Products

| Field | Needed | What it is |
| --- | --- | --- |
| `chain` | yes | The shop's id: `woolworths`, `coles`, `aldi`, a bottle shop or chemist Restock knows (`danmurphys`, `bws`, `chemistwarehouse`, `priceline` and the others in Settings), or a shop your household added. Not `other`. Never `costco`. |
| `name` | yes | Up to 200 characters. |
| `id` | for prices in a `prices` table | Your own id for the product in this file (up to 80 letters, digits, `_ . : -`). A new product keeps it as its id on the server when it's free. |
| `store_product_id` | best | The shop's own product number (Woolworths stockcode, Coles id, Aldi sku). Up to 100 characters. |
| `barcode` | no | 8, 12, 13 or 14 digits. Anything else is left out and the product goes in without it. |
| `brand` | no | Up to 100 characters. |
| `size` | no | As the shop writes it ("2L", "10 x 375mL"), up to 40 characters. |
| `qty`, `qty_unit` | no | The size as a number and unit: `g`, `ml` or `ea` (`2000` and `ml` for 2 L). Both or neither. |
| `image_url` | no | Taken only from a picture address your household's phones already use for that shop's products (https). Others are left out: an address could point anywhere. |

**The same product:** a product already on the server is used (and never changed) when it has the same `id` at
the same shop, else the same shop and `store_product_id`, else the same shop and `barcode`, else (only when the
file gives neither) the same shop, name and size.

### Prices

| Field | Needed | What it is |
| --- | --- | --- |
| `date` | yes | `2026-11-10` (counted as noon that day in the server's time zone), `2026-11-10T06:30:00` (the server's time zone), or with a zone (`2026-11-09T20:30:00Z`, `+10:00`). From 2000 up to today. |
| `price` | yes | The price in dollars, a number from 0.01 to 10,000 (`3.1`, not `"$3.10"`). |
| `was_price` | no | The usual price when it's on special. Kept only when above `price`. |
| `is_special` | no | `true` or `false` (or 1 or 0). |
| `member_only` | no | `true` or `false`: a members' price. |
| `promo` | no | The shop's words, up to 120 characters. |
| `product_id` | in a `prices` table | The `id` of its product in this file. |

**One a day:** each product keeps one price a day. The newest of a day in the file is the one used. When the
server already has that day at the same price, it's skipped. When the server has that day at another price,
the newest wins: the imported one goes in only when it's later in the day. A day that already has an imported
price (from earlier in the same file or an earlier import) keeps that one.

### What's never imported

A file is refused whole if it has a card number, a PIN, a password or passphrase, a key or token, a recovery
key, a receipt's words or photos, or a picture inside it (fields or tables named like `cards`, `number`, `pin`,
`password`, `passphrase`, `secret`, `token`, `key`, `recovery`, `text` or `photo` on a receipt). Take them out
and try again. Everything else in an export file (pantry items, the shopping list, receipts' details, shops,
settings) is left as it is: an import takes products and prices only, and says what it didn't take.

## Limits

| | |
| --- | --- |
| A file | up to 100 MB (300 MB unzipped) |
| One import | up to 25,000 products and 500,000 prices: split a bigger file |
| A product | up to 5,000 prices |
| The server | holds up to 50,000 products: past that an import adds prices to the ones it has but no new products |
| At once | one import on the server at a time; 10 imports an hour |

## Where imported prices show

- The Data tab: **Prices recorded** says how many are imported, and **Price over time** has an *imported* tag
  when the chart shows imported prices. Imported prices count like any other in the charts, usual prices and
  great deals.
- Your phones: every product goes to the phones that share its shop's tab, with its newest imported price when
  that is from the last 60 days and newer than any the server had. The older history stays on the server (the
  Data tab, the export, the encrypted backup), so the phones don't have to carry it.
- The export: imported prices have `"source": "imported"`.

## Deleting imported prices

Imported prices are price history like the rest: **Manage data** deletes them with the others (each product
keeps its newest price). The products stay in the catalogue.
