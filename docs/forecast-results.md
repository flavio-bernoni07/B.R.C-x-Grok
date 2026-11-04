# Buy or wait: backtest and this week's advice

Weekly Italian paddy prices from the EU Agri-food Data Portal, world rice prices from the World Bank Pink Sheet in euros (ECB rates). Rebuild with `python -m forecast_quality.data` then `python -m forecast_quality.advisor`.

**Backtest, 64 variety-campaigns, 2017/18 to 2025/26:** the advisor paid +0.38% against buying the same amount every week (+1.93 €/t on average; it did better in 32 of 64). At 200,000 t a year and the average price of €513/t that is about €390,911 a year (the tonnage is our estimate, to check with the mentor). A positive number means the advisor paid less.

**Read this as: no proven edge yet.** The advisor beat even buying in half the variety-campaigns, and when the price moved more than 2% in 8 weeks the model called the direction right 57% of the time (1122 weeks). The signals and the weekly memo are useful to the buyer; the saving is not yet something to promise. We did not tune the model on this backtest, which would only fit the past.

| Campaign | Variety | Even buying €/t | Advisor €/t | Saved €/t |
|---|---|---|---|---|
| 2017/2018 | Carnaroli | 323.35 | 323.33 | +0.02 |
| 2017/2018 | Arborio | 324.80 | 331.07 | -6.27 |
| 2017/2018 | Selenio | 297.55 | 303.02 | -5.47 |
| 2017/2018 | S. Andrea | 319.00 | 321.60 | -2.60 |
| 2017/2018 | Baldo | 408.91 | 409.64 | -0.73 |
| 2017/2018 | Roma | 290.55 | 298.52 | -7.97 |
| 2017/2018 | Loto | 356.03 | 357.69 | -1.66 |
| 2018/2019 | Carnaroli | 441.69 | 447.38 | -5.69 |
| 2018/2019 | Arborio | 464.33 | 472.37 | -8.03 |
| 2018/2019 | Selenio | 448.24 | 442.07 | +6.18 |
| 2018/2019 | S. Andrea | 413.29 | 407.04 | +6.25 |
| 2018/2019 | Long B | 297.41 | 301.10 | -3.68 |
| 2018/2019 | Baldo | 401.43 | 396.71 | +4.71 |
| 2018/2019 | Roma | 383.79 | 378.18 | +5.61 |
| 2018/2019 | Loto | 370.42 | 371.81 | -1.39 |
| 2019/2020 | Carnaroli | 450.00 | 443.55 | +6.45 |
| 2019/2020 | Arborio | 407.36 | 414.86 | -7.50 |
| 2019/2020 | Selenio | 395.64 | 397.24 | -1.60 |
| 2019/2020 | S. Andrea | 446.71 | 439.74 | +6.97 |
| 2019/2020 | Long B | 300.82 | 294.43 | +6.38 |
| 2019/2020 | Baldo | 422.77 | 410.52 | +12.26 |
| 2019/2020 | Roma | 391.83 | 382.13 | +9.70 |
| 2019/2020 | Loto | 365.03 | 360.27 | +4.76 |
| 2020/2021 | Carnaroli | 494.78 | 496.23 | -1.45 |
| 2020/2021 | Arborio | 458.93 | 455.90 | +3.03 |
| 2020/2021 | Selenio | 381.12 | 368.31 | +12.81 |
| 2020/2021 | S. Andrea | 427.58 | 427.20 | +0.38 |
| 2020/2021 | Long B | 343.86 | 335.20 | +8.66 |
| 2020/2021 | Baldo | 408.03 | 414.01 | -5.99 |
| 2020/2021 | Roma | 380.91 | 381.14 | -0.23 |
| 2020/2021 | Loto | 360.61 | 360.08 | +0.53 |
| 2021/2022 | Carnaroli | 785.08 | 743.64 | +41.44 |
| 2021/2022 | Selenio | 725.37 | 677.97 | +47.40 |
| 2021/2022 | S. Andrea | 513.28 | 486.28 | +27.00 |
| 2021/2022 | Long B | 435.07 | 419.57 | +15.50 |
| 2021/2022 | Baldo | 515.02 | 487.90 | +27.12 |
| 2021/2022 | Roma | 514.66 | 487.60 | +27.06 |
| 2021/2022 | Loto | 483.17 | 463.65 | +19.52 |
| 2022/2023 | Carnaroli | 1151.98 | 1205.00 | -53.02 |
| 2022/2023 | Arborio | 936.94 | 989.64 | -52.69 |
| 2022/2023 | Selenio | 619.07 | 636.53 | -17.47 |
| 2022/2023 | S. Andrea | 844.68 | 834.52 | +10.16 |
| 2022/2023 | Long B | 466.19 | 470.13 | -3.94 |
| 2022/2023 | Loto | 748.79 | 738.69 | +10.10 |
| 2023/2024 | Carnaroli | 605.63 | 614.96 | -9.33 |
| 2023/2024 | Arborio | 582.73 | 598.98 | -16.24 |
| 2023/2024 | Selenio | 539.37 | 540.63 | -1.26 |
| 2023/2024 | S. Andrea | 758.16 | 755.84 | +2.32 |
| 2023/2024 | Long B | 477.31 | 478.20 | -0.89 |
| 2023/2024 | Loto | 542.00 | 534.00 | +8.00 |
| 2024/2025 | Carnaroli | 966.38 | 949.40 | +16.98 |
| 2024/2025 | Arborio | 897.58 | 868.88 | +28.70 |
| 2024/2025 | Selenio | 632.84 | 635.37 | -2.53 |
| 2024/2025 | S. Andrea | 769.00 | 769.00 | +0.00 |
| 2024/2025 | Long B | 501.60 | 501.60 | +0.00 |
| 2024/2025 | Baldo | 672.31 | 656.62 | +15.69 |
| 2024/2025 | Roma | 721.00 | 721.00 | +0.00 |
| 2025/2026 | Carnaroli | 693.37 | 691.47 | +1.89 |
| 2025/2026 | Arborio | 567.95 | 567.92 | +0.03 |
| 2025/2026 | Selenio | 598.45 | 614.13 | -15.68 |
| 2025/2026 | S. Andrea | 452.05 | 469.38 | -17.33 |
| 2025/2026 | Long B | 355.75 | 357.31 | -1.56 |
| 2025/2026 | Baldo | 438.54 | 453.78 | -15.24 |
| 2025/2026 | Roma | 365.03 | 367.78 | -2.75 |

## This week

| Variety | Week | €/t | A year ago | Expected in 8 weeks | Call |
|---|---|---|---|---|---|
| Carnaroli | 2026-10-19 | 672 | 741 | +3.4% | BUY MORE |
| Arborio | 2026-10-19 | 576 | 625 | +3.3% | BUY MORE |
| Selenio | 2026-10-19 | 432 | 625 | +5.8% | BUY MORE |
| S. Andrea | 2026-10-19 | 432 | 577 | +6.2% | BUY MORE |
| Long B | 2026-10-19 | 375 | 385 | +4.5% | BUY MORE |
| Baldo | 2026-10-19 | 432 | 528 | +4.0% | BUY MORE |
| Roma | 2026-10-19 | 432 | 432 | +3.0% | BUY MORE |

Limits: prices are farm-gate averages, not what Riso Scotti pays; the backtest ignores storage cost and contracts signed at sowing; a person signs every purchase.
