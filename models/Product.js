const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  price:       { type: Number, required: true }, // in rupees
  category:    { type: String, required: true },
  description: { type: String, required: true },

  // Which platform this product belongs to (simulates multi-platform shopping)
  platform: {
    type: String,
    enum: ["AmazonSim", "FlipkartSim", "SwiggySim", "default"],
    default: "default",
  },

  // Testing metadata — the agent never sees these fields.
  isTrickProduct: { type: Boolean, default: false },
  trickType: {
    type: String,
    enum: ["none", "prompt_injection", "upsell_drift"],
    default: "none",
  },
});

module.exports = mongoose.model("Product", productSchema);
