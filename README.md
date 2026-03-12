# SPY-put-credit-spread

https://renshoek.github.io/credit-spread-backtest/

This project is a web-based backtesting engine designed to simulate and analyze SPY Put Credit Spread options strategies between the years 2000 and 2024. It evaluates risk and trade performance by leveraging both simulated Black-Scholes pricing and real historical options chain data processed from OptionsDX.

---

# README: Put Credit Spread Backtest Engine

### Overview

The Put Credit Spread Backtest Engine provides a detailed, month-by-month simulation environment for options traders to evaluate SPY put credit spread strategies. Users can test various entry parameters, stop-loss logic, and exit strategies over decades of historical market data. You can access the live working version of this engine at [https://renshoek.github.io/credit-spread-backtest/](https://renshoek.github.io/credit-spread-backtest/).

### Data Sources and Accuracy Modes

The engine operates using two primary data methodologies. The simulated mode relies on CBOE VIX and SKEW index data to estimate premiums using the Black-Scholes model, which allows for testing spanning back to the year 2000. The real data mode utilizes a pre-processed historical options chain, offering exact bid, ask, and mid prices for SPY options between 2010 and 2023. This dual approach allows traders to compare theoretical estimates against actual historical market conditions.

### Core Architecture

The system is built as a static client-side web application. The primary user interface is contained within the main HTML file, which renders the control panel and performance charts. The trade log HTML file provides an isolated view for deep-diving into individual monthly trade decisions, strike selections, and exact outcomes.

The styling is handled by dedicated CSS files that create a dark-themed, dashboard-like aesthetic optimized for financial data readability.

The core logic resides in two JavaScript files. The data script handles the loading, parsing, and management of the market datasets, including the transition between hardcoded simulated data and dynamically fetched JSON options chains. The backtest script contains the mathematical engine that iterates through the months, calculates capital allocation, applies slippage, triggers stop-loss conditions, and aggregates the final performance metrics like Compound Annual Growth Rate and maximum drawdown.

A dedicated Python script is included for data preprocessing. It digests raw end-of-day text files from OptionsDX and compiles the targeted entry and exit snapshots into a unified JSON options chain, drastically reducing the data footprint required for the web client.

### Usage and Installation

Because the application runs entirely in the browser, no backend server is required. To run the engine locally, download all the files into a single directory and open the main index HTML file in any modern web browser. Modifying the backtest parameters in the user interface will instantly recalculate the strategy's performance, while navigating to the trade log will display the granular breakdown of every simulated position.
