function isClosed(date, hour) {

  const day = date.getDay();

  // Κυριακή = ΚΛΕΙΣΤΑ
  if (day === 0) {
    return true;
  }

  // Σάββατο = μόνο 10:00 έως 14:00
  // Άρα διαθέσιμες ώρες: 10:00, 11:00, 12:00, 13:00
  if (day === 6) {
    return hour < 10 || hour > 13;
  }

  // Δευτέρα, Τετάρτη, Παρασκευή
  // 16:00 έως 19:00 ΚΛΕΙΣΤΑ
  if (
    CLOSED_DAYS.includes(day) &&
    hour >= CLOSED_FROM &&
    hour <= CLOSED_TO
  ) {
    return true;
  }

  return false;
}
