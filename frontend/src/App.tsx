import React, { useEffect, useState } from 'react';
import CONFIG from './utils/config';
import { AppProvider, useApp } from './context/AppContext';
import LocationSelector from './components/LocationSelector';
import DateSelector from './components/DateSelector';
import MetricSelector from './components/MetricSelector';
import TemperatureContextDisplay from './components/TemperatureContext';
import LoadingOverlay from './components/LoadingOverlay';
import MainChart from './components/MainChart';
import HistogramChart from './components/HistogramChart';
import PeriodHistogramChart from './components/PeriodHistogramChart';
import SignificancePanel from './components/SignificancePanel';
import { Legend } from './components/Legend';
import ThemeToggle from './components/ThemeToggle';
import type { MetricKey } from './utils/config';
import './App.css';

// Metric phrases for the recent-memory question — matches the metric buttons.
const metricQuestionLabel: Record<MetricKey, string> = {
  max_temperature: 'max temperature',
  min_temperature: 'min temperature',
  precipitation_sum: 'precipitation',
  wind_speed_10m_max: 'wind speed',
};

const AppContent: React.FC = () => {
  const {
    location,
    setLocation,
    currentDate,
    setCurrentDate,
    currentMetric,
    setCurrentMetric,
    filteredData,
    fullData,
    yearlyAggregates,
    temperatureContext,
    maxAvailableDate,
    loading,
    error,
  } = useApp();

  const handleLocationChange = (name: string, lat: number, lon: number) => {
    setLocation({ lat, lon, name });
  };

  const handleDateChange = (date: string) => {
    setCurrentDate(date);
  };

  const handleMetricChange = (metric: any) => {
    setCurrentMetric(metric);
  };

  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const [mobileWidth, setMobileWidth] = useState(
    typeof window !== 'undefined' ? Math.min(window.innerWidth - 60, 420) : 360
  );
  useEffect(() => {
    const onResize = () => setMobileWidth(Math.min(window.innerWidth - 60, 420));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const formatChartTitle = (dateStr: string) => {
    const d = new Date(dateStr + 'T12:00:00');
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const day = d.getDate();
    const suffix =
      day % 10 === 1 && day !== 11 ? 'st' :
      day % 10 === 2 && day !== 12 ? 'nd' :
      day % 10 === 3 && day !== 13 ? 'rd' : 'th';
    return `${months[d.getMonth()]} ${day}${suffix} ± ${CONFIG.chart.seasonalWindowDays} days`;
  };

  // Get current date data for temperature context
  const getCurrentTemp = () => {
    const currentDateData = filteredData.filter(
      (d) => d.date.toDateString() === new Date(currentDate).toDateString()
    );
    if (currentDateData.length > 0) {
      return currentDateData[0][currentMetric] ?? null;
    }
    return null;
  };

  return (
    <div className="app">
      <LoadingOverlay show={loading} />

      <div className="app-container">
        <div className="sticky-bar">
          <header className="app-header">
            <h1>Weather Rank</h1>
            <ThemeToggle />
          </header>

          <div className="controls-panel">
            <div className="controls-row">
              <LocationSelector
                cityName={location.name || ''}
                latitude={location.lat}
                longitude={location.lon}
                onChange={handleLocationChange}
              />

              <DateSelector
                currentDate={currentDate}
                onChange={handleDateChange}
                maxDate={maxAvailableDate}
              />
            </div>
            {!loading && !error && filteredData.length > 0 && (
              <MetricSelector currentMetric={currentMetric} onChange={handleMetricChange} />
            )}
          </div>
        </div>

        {error && (
          <div className="error-message">
            <strong>Error:</strong> {error}
          </div>
        )}

        {!loading && !error && filteredData.length > 0 && (
          <div className="data-panel">
            {/* Section 1 — the answer at a glance */}
            <section className="page-section">
              <TemperatureContextDisplay
                context={temperatureContext}
                currentTemp={getCurrentTemp()}
                filteredData={filteredData}
                currentMetric={currentMetric}
              />
            </section>

            {/* Section 2 — the full record */}
            <section className="page-section">
              <header className="section-header">
                <h2 className="section-title">The Data</h2>
              </header>
              <div className="charts-section">
                <div className="chart-title">{formatChartTitle(currentDate)}</div>
                <Legend metric={currentMetric} />
                <div className={`charts-container ${isMobile ? 'mobile' : ''}`}>
                  {isMobile ? (
                    <>
                      <HistogramChart
                        filteredData={filteredData}
                        currentMetric={currentMetric}
                        currentDate={currentDate}
                        fullData={fullData}
                        orientation="vertical"
                        width={mobileWidth}
                        height={115}
                      />
                      <MainChart
                        filteredData={filteredData}
                        yearlyAggregates={yearlyAggregates}
                        currentMetric={currentMetric}
                        currentDate={currentDate}
                        fullData={fullData}
                        orientation="vertical"
                        width={mobileWidth}
                        height={460}
                      />
                    </>
                  ) : (
                    <>
                      <MainChart
                        filteredData={filteredData}
                        yearlyAggregates={yearlyAggregates}
                        currentMetric={currentMetric}
                        currentDate={currentDate}
                        fullData={fullData}
                      />
                      <HistogramChart
                        filteredData={filteredData}
                        currentMetric={currentMetric}
                        currentDate={currentDate}
                        fullData={fullData}
                      />
                    </>
                  )}
                </div>
              </div>
            </section>

            {/* Section 3 — recent-memory trend */}
            <section className="page-section">
              <header className="section-header">
                <h2 className="section-title">The Broader Stats</h2>
                <p className="section-subtitle">
                  Did {metricQuestionLabel[currentMetric]} at this time of
                  year change in recent memory?
                </p>
              </header>
              <div className="chart-title">{formatChartTitle(currentDate)}</div>
              <div className={`period-histogram-row ${isMobile ? 'mobile' : ''}`}>
                <PeriodHistogramChart
                  filteredData={filteredData}
                  currentMetric={currentMetric}
                  /* Desktop: span the main chart (760) plus the per-date
                     histogram's bar area, stopping where the % brackets begin
                     (~890), and left-align (see .period-histogram-row) so the
                     temp x-axis lines up with the main chart above. */
                  width={isMobile ? mobileWidth : 890}
                  panelHeight={isMobile ? 64 : 72}
                />
              </div>
              <SignificancePanel
                filteredData={filteredData}
                currentMetric={currentMetric}
              />
            </section>

            {/* Section 4 — FAQ */}
            <section className="page-section">
              <header className="section-header">
                <h2 className="section-title">FAQ</h2>
              </header>
              <div className="faq-list">
                <details className="faq-item">
                  <summary>What's this data?</summary>
                  <div className="faq-body">
                    <p>
                      The historical record comes from{' '}
                      <strong>
                        <a
                          href="https://www.ecmwf.int/en/era5-land"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          ERA5-Land
                        </a>
                      </strong>
                      , the European Centre for Medium-Range Weather Forecasts'
                      reanalysis. A reanalysis isn't a forecast and it isn't a single
                      weather station — it's the output of running a modern physics
                      model backwards over every observation we have (stations,
                      balloons, ships, satellites) to reconstruct a single, gap-free,
                      globally consistent estimate of what the weather actually did.
                      ERA5-Land gives one value per day per cell on a fixed 0.1° grid
                      (roughly 11 km), so the seam between cities is never an artifact
                      of where a thermometer happened to sit.{' '}
                    </p>
                    <p>
                      When you search a city we snap it to the nearest grid cell
                      centre rather than interpolating — the number you see is a real
                      ERA5-Land cell, not a blend. We show daily maximum and minimum
                      temperature, precipitation, and peak wind.
                    </p>
                    <p>
                      A reanalysis can't cover the present: ERA5-Land lags real time
                      by several days, so the last week or two — and the few days
                      ahead — have to come from elsewhere. The forecast days use{' '}
                      <a
                        href="https://www.ecmwf.int/en/forecasts/documentation-and-support/medium-range-forecasts"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <strong>ECMWF's IFS HRES</strong>
                      </a>, the 9 km high-resolution
                      deterministic model. We use that one specifically because it's
                      from the same institution that builds ERA5, so the physics and
                      the variables line up as closely as a forecast reasonably can
                      with the archive it's extending.{' '}
                      
                    </p>
                    <p>
                      One caveat: this most-recent tail is the least settled part of
                      the record. The last several days are a forecast rather than a
                      reconstruction, and even the just-past days haven't been through
                      the full reanalysis yet — so a value here can shift by a degree
                      or two as the model firms up, and won't always match a reading
                      you remember. It's shown for context only and is{' '}
                      <em>never</em> mixed into the long-run statistics below.
                    </p>
                  </div>
                </details>
                <details className="faq-item">
                  <summary>What are these metrics?</summary>
                  <div className="faq-body">
                    <p>
                      Every number here is a <strong>daily</strong> value — one figure
                      summarising a single 24-hour day, not an hourly reading or a
                      monthly average. There are four:
                    </p>
                    <p>
                      <strong>Max temperature</strong> is the hottest the air got that
                      day — the peak of the afternoon. <strong>Min temperature</strong>{' '}
                      is the coldest it got — the bottom of the night, usually just
                      before dawn. Between them they bracket the day's full swing.
                    </p>
                    <p>
                      <strong>Wind speed</strong> is the day's strongest sustained
                      wind, measured 10 m above the ground. It{' '}
                      <em>excludes gusts</em> — the brief, sharp spikes that can be far
                      higher — so it reflects how hard the wind was steadily blowing
                      rather than its momentary peaks.
                    </p>
                    <p>
                      <strong>Precipitation</strong> is the total water that fell over
                      the day, and "water" is the key word: it counts{' '}
                      <em>everything</em>, not just rain. Snow, sleet and hail are all
                      melted down to their liquid equivalent before being added up. As
                      a rough rule of thumb, about <strong>10 cm of fresh snow melts
                      down to ~1 mm</strong> of precipitation — so a number that looks
                      small on a winter day can still mean a lot of snow on the ground.
                    </p>
                  </div>
                </details>
                <details className="faq-item">
                  <summary>Why ±5 days?</summary>
                  <div className="faq-body">
                    <p>
                      To say whether a given day was extreme, you need something to
                      compare it against — and the only fair comparison is{' '}
                      <em>the same time of year</em>. A 25° day is unremarkable in
                      July and astonishing in January, so we never pool the whole
                      year together. Instead we line up every year's version of the
                      date you picked and ask: against all the other times this
                      calendar slot has come around, how does this one rank?
                    </p>
                    <p>
                      But a single calendar day across ~75 years is only ~75 data
                      points, and any one of them can be a fluke. So we widen the
                      slot to a <strong>±5-day window</strong> around your date — June
                      5th pulls in May 31st through June 10th, every year. That's an
                      order of magnitude more days to characterise "what this part of
                      the season normally does," which makes the percentiles and the
                      ranking far more stable.
                    </p>
                    <p>
                      Five days is the sweet spot: wide enough to beat down the noise,
                      but narrow enough that the weather hasn't meaningfully drifted
                      into a different season. The climate barely moves across eleven
                      days, so you're still comparing apples to apples — which is
                      exactly what lets the answer to "how extreme was <em>this</em>{' '}
                      weather?" actually mean something.
                    </p>
                  </div>
                </details>
                <details className="faq-item">
                  <summary>Satellites?</summary>
                  <div className="faq-body">
                    <p>
                      A reanalysis is only as good as what it can swallow. Before
                      the satellite era most of the planet — oceans, deserts, the
                      poles, anywhere without a dense station network — was simply
                      unobserved, so the model has to lean harder on its own physics
                      to fill the gaps. The big regime change is{' '}
                      <strong>1979</strong>, when continuous global satellite
                      sounding came online and the reanalysis gained eyes everywhere
                      at once.
                    </p>
                    <p>
                      That's why anything before 1979 is shaded on the time chart and
                      marked with a dashed boundary: the data still exists and ERA5
                      extends back to 1950, but the early decades carry materially
                      more uncertainty, especially for day-to-day extremes. Treat the
                      shaded band as "directionally real, but trust it less."
                    </p>
                  </div>
                </details>
                <details className="faq-item">
                  <summary>Why these stats?</summary>
                  <div className="faq-body">
                    <p>
                      The whole point is an honest apples-to-apples comparison, so
                      every choice is about removing ways to accidentally fool
                      yourself.
                    </p>
                    <p>
                      <strong>Equal 15-year windows.</strong> We split the record
                      into three back-to-back blocks of exactly 15 years and compare
                      the oldest against the newest. Equal lengths matter: a longer
                      window catches more rare extremes purely by having more days in
                      it, so comparing a 15-year span to a 40-year span would bake in
                      a bias before you've measured anything. Fifteen years is long
                      enough to average out individual flukey seasons (El Niño years,
                      one freak heatwave) but short enough that the two windows don't
                      overlap.
                    </p>
                    <p>
                      <strong>Start after the satellites.</strong> The windows are
                      anchored so the comparison stays inside the well-observed,
                      post-1979 era wherever possible — see above. We're not going to
                      hang a "it's getting hotter" claim on the noisiest part of the
                      record.
                    </p>
                    <p>
                      <strong>No forecast data in the stats.</strong> The recent and
                      forecast tiers exist so today's number isn't blank, but they're
                      a different model from the archive and carry a small bias at the
                      seam. Letting them into a 15-year aggregate would be comparing a
                      consistent reanalysis to a patchwork. So the statistics use the
                      ERA5-Land archive only.
                    </p>
                    <p>
                      <strong>Medians, not means (and the 90th percentile for
                      rain).</strong> The median is the typical day, and unlike the
                      mean it isn't yanked around by a single record-shattering
                      outlier — which is exactly the kind of day that's most prone to
                      measurement error. Precipitation is different: most days are
                      bone dry, so the median is usually just 0 and tells you nothing.
                      For rain we compare the <strong>90th percentile</strong>{' '}
                      instead — the wet tail — because "how bad do the bad days get"
                      is the question that actually matters there.
                    </p>
                    <p>
                      <strong>A permutation test, not a t-test.</strong> To decide
                      whether the gap between old and new is real or just luck, we run
                      a permutation test: pool both periods, repeatedly reshuffle the
                      labels at random, and see how often pure chance produces a gap
                      as big as the one we observed. Two reasons it beats a classic
                      t-test here. First, it's{' '}
                      <strong>non-parametric</strong> — it makes no assumption that
                      the data are normally distributed, which daily temperatures and
                      especially rainfall flatly are not. Second, and more important,
                      weather is heavily <strong>autocorrelated</strong>: today looks
                      like yesterday, and a hot July is a hot July all month. A
                      standard t-test treats every day as an independent data point,
                      which massively overstates how much information you really have
                      and produces falsely tiny p-values. So we shuffle whole years as
                      indivisible blocks rather than individual days — that keeps each
                      year's internal correlation intact and gives an honest p-value
                      instead of an inflated one.
                    </p>
                  </div>
                </details>
                <details className="faq-item">
                  <summary>Why do this?!</summary>
                  <div className="faq-body">
                    <p>I just wanted to know if certain days realy ARE as extreme as 
                       they feel.. and now we know!
                    </p>
                  </div>
                </details>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
};

export default App;
