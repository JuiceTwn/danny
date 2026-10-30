// Open-Meteo: free, no key. Only a place name and coordinates leave the server, never anything else about the user.
const CODES: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "rain showers", 82: "heavy showers",
  95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail",
};

/** One plain line about today's weather, or null if the place isn't found or the service is down. */
export async function todaysWeather(place: string, units: "metric" | "imperial", fetchFn: typeof fetch = fetch): Promise<string | null> {
  const get = async (url: string) => {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(8_000) });
    return res.ok ? ((await res.json()) as any) : null;
  };
  try {
    const geo = await get(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: place.split(",")[0]!.trim(), count: "1" })}`);
    const hit = geo?.results?.[0];
    if (!hit) return null;
    const f = await get(
      `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
        latitude: String(hit.latitude),
        longitude: String(hit.longitude),
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        timezone: "auto",
        forecast_days: "1",
        temperature_unit: units === "imperial" ? "fahrenheit" : "celsius",
      })}`,
    );
    const d = f?.daily;
    if (!d) return null;
    const deg = units === "imperial" ? "°F" : "°C";
    const rain = Number(d.precipitation_probability_max?.[0] ?? 0);
    return `${hit.name}: ${CODES[Number(d.weather_code?.[0])] ?? "mixed"}, high ${Math.round(d.temperature_2m_max[0])}${deg}, low ${Math.round(d.temperature_2m_min[0])}${deg}${rain >= 30 ? `, ${rain}% chance of rain` : ""}`;
  } catch {
    return null;
  }
}
