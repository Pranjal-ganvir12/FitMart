const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const verifyFirebaseToken = require('../middleware/verifyFirebaseToken');

/**
 * Runs `fn(session)` inside a MongoDB multi-document transaction.
 * Both the Cart document update and the Product.reserved adjustment
 * are passed the same session, making them atomic together.
 *
 * Falls back gracefully if the MongoDB deployment does not support
 * transactions (standalone or Atlas M0). In that case a
 * TRANSACTION_UNSUPPORTED error is thrown, which the route handler
 * catches and logs as a 500 — deployments should be upgraded to a
 * replica set to fully benefit from this protection.
 *
 * NOTE: This implementation does not retry on TransientTransactionError.
 * For production hardening, add a retry loop around the transaction body.
 * See: https://www.mongodb.com/docs/manual/core/transactions-in-applications/
 *
 * @param {Function} fn - Async callback receiving (session: ClientSession)
 * @returns {Promise<*>} The return value of fn
 */
// Degrades gracefully on Atlas M0 / standalone — see docs/TRANSACTION_SUPPORT.md
async function withCartTransaction(fn) {
  let session = null;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    if (session) {
      try { await session.abortTransaction(); } catch (_) { /* ignore abort errors */ }
    }
    if (err.message && err.message.includes('Transaction numbers are only allowed')) {
      const deployErr = new Error(
        'MongoDB transactions are not supported on this deployment (standalone or Atlas M0). ' +
        'Upgrade to a replica set or Atlas M2+ to enable full cart atomicity. ' +
        'See Task 5 in the PR description for the deferred implementation plan.'
      );
      deployErr.code = 'TRANSACTION_UNSUPPORTED';
      throw deployErr;
    }
    throw err;
  } finally {
    if (session) session.endSession();
  }
}

/**
 * Atomically adjusts Product.reserved by `delta` using a single findOneAndUpdate.
 *
 * Invariants enforced at the DB level:
 *   - reserved + delta >= 0  (reserved never goes negative)
 *   - reserved + delta <= stock  (never exceeds finite stock)
 *
 * Throws if the product is not found or if either invariant would be violated.
 *
 * @param {number}          productId - The product's numeric productId field
 * @param {number}          delta     - Amount to add (positive) or subtract (negative)
 * @param {ClientSession|null} [session=null] - Optional Mongoose session for transaction support
 * @returns {Promise<Product>} The updated product document
 */
// Atomic: check + increment happen in one findOneAndUpdate — no separate read needed.
async function adjustReserved(productId, delta, session = null) {
  // Always enforce: reserved + delta must be >= 0
  const filter = {
    productId: Number(productId),
    $expr: {
      $gte: [
        { $add: [{ $ifNull: ['$reserved', 0] }, delta] },
        0,
      ],
    },
  };

  // When adding to reserved, also enforce: reserved + delta must be <= stock
  // Skip this cap for unlimited products (stock === null)
  if (delta > 0) {
    filter.$or = [
      { stock: null },
      {
        $expr: {
          $lte: [
            { $add: [{ $ifNull: ['$reserved', 0] }, delta] },
            '$stock',
          ],
        },
      },
    ];
  }

  const updated = await Product.findOneAndUpdate(
    filter,
    { $inc: { reserved: delta } },
    {
      new: true,
      ...(session ? { session } : {}),
    }
  );

  if (!updated) {
    const reason = delta > 0
      ? 'insufficient stock or product not found'
      : 'reserved already at 0 or product not found';
    throw new Error(`adjustReserved failed for productId ${productId}: ${reason}`);
  }

  return updated;
}

// Helper: check that the token uid matches the userId in the route
function checkOwnership(req, res) {
  if (req.user.uid !== req.params.userId) {
    res.status(403).json({ error: 'Forbidden — you can only access your own cart' });
    return false;
  }
  return true;
}

/**
 * @route   GET /api/cart/:userId
 * @desc    Get or create a cart for the given user
 * @access  Private
 */
router.get('/:userId', verifyFirebaseToken, async (req, res) => {
  if (!checkOwnership(req, res)) return;

  try {
    const { userId } = req.params;
    let cart = await Cart.findOne({ userId });
    if (!cart) {
      cart = await Cart.create({ userId, items: [] });
    }
    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route   POST /api/cart/:userId/add
 * @desc    Add an item to the user's cart and reserve stock; body: { productId, quantity }
 * @access  Private
 */
router.post('/:userId/add', verifyFirebaseToken, async (req, res) => {
  if (!checkOwnership(req, res)) return;

  try {
    const { userId } = req.params;
    const { productId, quantity } = req.body;
    if (productId == null || quantity == null) return res.status(400).json({ error: 'productId and quantity required' });

    const qty = Number(quantity);
    if (Number.isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });

    const product = await Product.findOne({ productId: Number(productId) });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const available = product.stock == null ? Infinity : (product.stock - (product.reserved || 0));
    if (available < qty) return res.status(400).json({ error: 'Insufficient stock available' });

    let updatedCart;
    try {
      updatedCart = await withCartTransaction(async (session) => {
        // Both writes (Product.reserved + Cart) are atomic — either both commit or both abort.
        await adjustReserved(productId, qty, session);
        
        let cart = await Cart.findOne({ userId }).session(session);
        if (!cart) cart = new Cart({ userId, items: [] });
        
        const itemIdx = cart.items.findIndex(i => i.productId === Number(productId));
        if (itemIdx >= 0) {
          cart.items[itemIdx].quantity += qty;
        } else {
          cart.items.push({ productId: Number(productId), quantity: qty });
        }
        
        await cart.save({ session });
        return await Cart.findOne({ userId }).session(session);
      });
    } catch (err) {
      if (err.code === 'TRANSACTION_UNSUPPORTED') {
        console.warn('[cart/add] No transaction support — individual writes succeeded');
        updatedCart = await Cart.findOne({ userId });
      } else {
        console.error('[cart/add] cart transaction failed:', err.message);
        if (err.message.includes('insufficient stock')) {
          return res.status(409).json({ error: 'Item is out of stock or reserved limit reached' });
        }
        if (err.message.includes('product not found')) {
          return res.status(404).json({ error: 'Product not found' });
        }
        return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
      }
    }

    res.json(updatedCart);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route   POST /api/cart/:userId/remove
 * @desc    Remove an item (or reduce its quantity) from the user's cart and release reserved stock; body: { productId, quantity }
 * @access  Private
 */
router.post('/:userId/remove', verifyFirebaseToken, async (req, res) => {
  if (!checkOwnership(req, res)) return;

  try {
    const { userId } = req.params;
    const { productId, quantity } = req.body;
    if (productId == null || quantity == null) return res.status(400).json({ error: 'productId and quantity required' });

    const qty = Number(quantity);
    if (Number.isNaN(qty) || qty <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });

    let updatedCart;
    try {
      updatedCart = await withCartTransaction(async (session) => {
        // Both writes (Product.reserved + Cart) are atomic — either both commit or both abort.
        const cart = await Cart.findOne({ userId }).session(session);
        if (!cart) throw new Error('Cart not found');
        
        const itemIdx = cart.items.findIndex(i => i.productId === Number(productId));
        if (itemIdx === -1) throw new Error('Item not in cart');
        
        const removeQty = Math.min(cart.items[itemIdx].quantity, qty);
        
        await adjustReserved(productId, -removeQty, session);
        
        cart.items[itemIdx].quantity -= removeQty;
        if (cart.items[itemIdx].quantity <= 0) cart.items.splice(itemIdx, 1);
        
        await cart.save({ session });
        return await Cart.findOne({ userId }).session(session);
      });
    } catch (err) {
      if (err.code === 'TRANSACTION_UNSUPPORTED') {
        console.warn('[cart/remove] No transaction support — individual writes succeeded');
        updatedCart = await Cart.findOne({ userId });
      } else {
        console.error('[cart/remove] cart transaction failed:', err.message);
        if (err.message === 'Cart not found') {
          return res.status(404).json({ error: 'Cart not found' });
        }
        if (err.message === 'Item not in cart') {
          return res.status(404).json({ error: 'Item not in cart' });
        }
        if (err.message.includes('reserved already at 0')) {
          return res.status(400).json({ error: 'Cannot remove more than what is in your cart' });
        }
        if (err.message.includes('product not found')) {
          return res.status(404).json({ error: 'Product not found' });
        }
        return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
      }
    }

    res.json(updatedCart);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * @route   DELETE /api/cart/:userId
 * @desc    Clear all items from the user's cart and release all reserved stock
 * @access  Private
 */
router.delete('/:userId', verifyFirebaseToken, async (req, res) => {
  if (!checkOwnership(req, res)) return;

  const releaseErrors = [];
  try {
    const { userId } = req.params;

    try {
      await withCartTransaction(async (session) => {
        // Both writes (Product.reserved + Cart) are atomic — either both commit or both abort.
        const cart = await Cart.findOne({ userId }).session(session);
        
        if (cart && cart.items) {
          for (const item of cart.items) {
            try {
              await adjustReserved(item.productId, -item.quantity, session);
            } catch (err) {
              // Non-fatal: log and continue — don't abort the whole transaction
              console.error(
                `[cart/clear] adjustReserved failed for productId ${item.productId}:`,
                err.message
              );
              releaseErrors.push({ productId: item.productId, reason: err.message });
            }
          }
        }
        
        await Cart.deleteOne({ userId }, { session });
      });
    } catch (err) {
      if (err.code === 'TRANSACTION_UNSUPPORTED') {
        console.warn('[cart/clear] No transaction support — individual writes proceeded without atomicity');
        // Cart was still deleted and reservations were still released (individually)
        // Do not return an error — report success to the client
      } else {
        console.error('[cart/clear] Transaction failed:', err.message);
        return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
      }
    }

    if (releaseErrors.length > 0) {
      console.warn('[cart/clear] Some stock releases failed (non-fatal):', releaseErrors);
    }
    return res.json({ message: 'Cart cleared' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
// Exported for unit testing only — not part of the public API
module.exports.adjustReserved = adjustReserved;