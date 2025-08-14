"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateDiscount = calculateDiscount;
exports.main = main;
function calculateDiscount(price) {
    if (price > 100) {
        return price * 0.9;
    }
    return price * 0.95;
}
function main() {
    const totalPrice = 150;
    const discountedPrice = calculateDiscount(totalPrice);
    console.log('Discounted:', discountedPrice);
}
//# sourceMappingURL=a.js.map