import { config } from './config.js';

/* RURA Board Decision 03/BD/RD-TRP/2021 (27 Sep 2021) as adjusted August 2022.
   Bites the first two kilometres, then per-kilometre rates, then a long-distance rate. */
export const FARE_RULE = 'RURA 03/BD/RD-TRP/2021, adjusted August 2022';

export const motoFare = {
  firstBandKm: config.fare.motorcycleFirstBandKm,
  minFareRwf: config.fare.motorcycleMinFareRwf,
  midRateRwf: config.fare.motorcycleMidRateRwf,
  midBandKm: config.fare.motorcycleMidBandKm,
  longRateRwf: config.fare.motorcycleLongRateRwf,
  freeWaitMinutes: config.fare.motorcycleFreeWaitMinutes,
  waitRateRwf: config.fare.motorcycleWaitRateRwf,
};

const round10 = (value) => Math.round(value / 10) * 10;
const round2 = (value) => Math.round(value * 100) / 100;

export function motorcycleFare(distanceKm, waitMinutes = 0) {
  const km = Math.max(0, Number(distanceKm) || 0);
  const components = [];
  let amount;
  if (km <= motoFare.firstBandKm) {
    amount = motoFare.minFareRwf;
    components.push({ type: 'first_band', km: round2(km), amountRwf: motoFare.minFareRwf });
  } else {
    let remaining = km - motoFare.firstBandKm;
    const midKm = Math.min(remaining, motoFare.midBandKm - motoFare.firstBandKm);
    amount = motoFare.minFareRwf + midKm * motoFare.midRateRwf;
    components.push({ type: 'first_band', km: motoFare.firstBandKm, amountRwf: motoFare.minFareRwf });
    components.push({ type: 'mid_band', km: round2(midKm), rateRwf: motoFare.midRateRwf, amountRwf: round2(midKm * motoFare.midRateRwf) });
    remaining -= midKm;
    if (remaining > 0) {
      amount += remaining * motoFare.longRateRwf;
      components.push({
        type: 'long_band',
        km: round2(remaining),
        rateRwf: motoFare.longRateRwf,
        amountRwf: round2(remaining * motoFare.longRateRwf),
        overKm: motoFare.midBandKm,
      });
    }
  }
  const chargeableWait = Math.max(0, (Number(waitMinutes) || 0) - motoFare.freeWaitMinutes);
  if (chargeableWait > 0) {
    amount += chargeableWait * motoFare.waitRateRwf;
    components.push({
      type: 'wait',
      minutes: chargeableWait,
      freeMinutes: motoFare.freeWaitMinutes,
      rateRwf: motoFare.waitRateRwf,
      amountRwf: chargeableWait * motoFare.waitRateRwf,
    });
  }
  return { fareRwf: Math.max(motoFare.minFareRwf, round10(amount)), components, rate: null };
}

/* Cars and taxis are not covered by the motorcycle decision, so their own rate still applies. */
export function fareFor(distanceKm, vehicleType, pricePerKm, waitMinutes = 0) {
  const km = Math.max(0, Number(distanceKm) || 0);
  if (vehicleType !== 'moto') {
    const rate = Number(pricePerKm) || 0;
    if (!rate) return { fareRwf: null, components: [], rate: null, basis: 'no_rate' };
    return {
      fareRwf: Math.max(round10(rate), round10(km * rate)),
      components: [{ type: 'driver_rate', km: round2(km), rateRwf: rate, amountRwf: round2(km * rate) }],
      rate,
      basis: 'driver_rate',
    };
  }
  return { ...motorcycleFare(km, waitMinutes), basis: FARE_RULE };
}

export const fareHealth = () => ({
  basis: FARE_RULE,
  motorcycle: { ...motoFare, rounding: 'nearest 10 RWF' },
});
