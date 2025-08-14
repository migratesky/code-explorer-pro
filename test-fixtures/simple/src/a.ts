export function calculateDiscount(price: number): number {
  if (price > 100) {
    return price * 0.9;
  }
  return price * 0.95;
}

export function main() {
  const totalPrice = 150;
  const discountedPrice = calculateDiscount(totalPrice);
  console.log('Discounted:', discountedPrice);
}
