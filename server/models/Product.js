const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema(
  {
    productId: { type: Number, unique: true, required: true },
    name: { type: String, required: true },
    brand: { type: String },
    category: { type: String },
    price: { type: Number, required: true },
    originalPrice: { type: Number, default: null },
    rating: { type: Number, default: 0 },
    reviews: { type: Number, default: 0 },
    badge: { type: String, default: null },
    image: { type: String, default: '' },
    // total stock available (optional). If null, stock is not enforced.
    stock: { type: Number, default: null },
    // quantity reserved by carts (sum of quantities currently in carts)
    reserved: {
      type: Number,
      default: 0,
      min: [0, 'reserved cannot be negative'],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Product', ProductSchema);
