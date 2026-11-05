# Retailer logos

Small square icons for the sidebar, one per retailer brand. Each was downloaded on 4 November 2026 from the brand's own site icon or, where the site only has a 16 to 48 px favicon, from the brand's own app icon on the Apple App Store. Each was then padded to a square on white and resized to 128 x 128 PNG (Pillow, Lanczos).

The logos are the retailers' trademarks. They are used only to name the retailer in the demo.

| File | Source | What it is |
|---|---|---|
| `esselunga.png` | https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/74/44/d8/7444d8b1-4469-b01a-0ebd-7978d6018296/AppIcon-0-0-1x_U007emarketing-0-5-0-sRGB-85-220.png/256x256bb.png | App icon of "Esselunga" (Esselunga SPA). esselunga.it has a 16 px favicon only |
| `carrefour.png` | https://www.carrefour.it/on/demandware.static/Sites-carrefour-IT-Site/-/default/dw31279051/images/favicons/favicon-196x196.png | carrefour.it site icon (512 px file) |
| `auchan.png` | https://www.auchan.fr/favicon.ico | auchan.fr favicon (128 px). Auchan no longer trades in Italy, so the French site |
| `conad.png` | https://www.conad.it/etc.clientlibs/conad-corporate/clientlibs/clientlib-site/resources/corporate/favicons/apple-touch-icon.png | conad.it apple-touch-icon (180 px) |
| `coop.png` | https://www.coop.it/sites/default/files/favicon.png | coop.it favicon (225 px); www.e-coop.it redirects to www.coop.it |
| `iper.png` | https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/33/cf/3f/33cf3fb9-7414-8f0e-36e1-066a85d3bd9e/AppIcon-0-0-1x_U007emarketing-0-6-0-85-220.png/256x256bb.png | App icon of "Iper, La grande i" (Iper Montebello Spa). iper.it has a 26 x 32 favicon only |
| `lidl.png` | https://www.lidl.it/apple-touch-icon.png | lidl.it apple-touch-icon (180 px) |
| `eurospin.png` | https://www.eurospin.com/etc.clientlibs/eurospin/clientlibs/clientlib-site/resources/images/favicon/apple-touch-icon.png | eurospin.it (redirects to eurospin.com/it-it) apple-touch-icon (180 px) |
| `bennet.png` | https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/61/42/b3/6142b357-b7d0-576a-7e9b-1197f8be1185/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/256x256bb.png | App icon of "Bennet spesa online" (BENNET SPA). bennet.com refuses scripted requests (403) |
| `pam.png` | https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/88/d9/df/88d9dfb6-0c03-c62b-48ee-2cd27136427b/AppIcon-0-0-1x_U007emarketing-0-11-0-85-220.png/256x256bb.png | App icon of "Pam Perte Plus" (PAM PANORAMA SPA): the Pam leaf with the loyalty "+". pampanorama.it has a 48 px favicon only |
| `despar.png` | https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/b1/01/0a/b1010a7b-10f1-a4ab-252c-b80af8d59404/AppIcon-0-0-1x_U007emarketing-0-11-0-85-220.png/256x256bb.png | App icon of "Despar Centro Sud" (Maiora SPA): the Despar tree. despar.it has a 16 px favicon only |
| `unes.png` | https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/fc/06/6f/fc066f1e-ec6b-77a7-b746-33bf674b2b5c/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/256x256bb.png | App icon of "Unes" (unes centro soc. coop.). unes.it has no icon larger than 32 px |

The App Store icon URLs came from the iTunes Search API (`https://itunes.apple.com/search?term=<brand>&entity=software&country=it`, field `artworkUrl512`, asked as a 256 px PNG).
