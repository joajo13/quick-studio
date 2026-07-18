-- quick-studio local demo seed.
-- Runs automatically on first boot of the postgres:16 container
-- (mounted into /docker-entrypoint-initdb.d/). Recreates the demo dataset
-- the app introspects: customers / products / orders / order_items + two views.

BEGIN;

CREATE TABLE customers (
  id          serial PRIMARY KEY,
  name        text        NOT NULL,
  email       text        NOT NULL UNIQUE,
  country     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id       serial PRIMARY KEY,
  name     text           NOT NULL,
  category text           NOT NULL,
  price    numeric(10, 2) NOT NULL CHECK (price >= 0)
);

CREATE TABLE orders (
  id           serial PRIMARY KEY,
  customer_id  integer     NOT NULL REFERENCES customers (id),
  status       text        NOT NULL DEFAULT 'paid',
  placed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id          serial PRIMARY KEY,
  order_id    integer        NOT NULL REFERENCES orders (id),
  product_id  integer        NOT NULL REFERENCES products (id),
  quantity    integer        NOT NULL CHECK (quantity > 0),
  unit_price  numeric(10, 2) NOT NULL CHECK (unit_price >= 0)
);

INSERT INTO customers (name, email, country) VALUES
  ('Ana Gómez',        'ana@example.com',     'Argentina'),
  ('Bruno Silva',      'bruno@example.com',   'Brazil'),
  ('Carla Ruiz',       'carla@example.com',   'Argentina'),
  ('Diego Fernández',  'diego@example.com',   'Chile'),
  ('Elena Costa',      'elena@example.com',   'Brazil'),
  ('Facundo López',    'facundo@example.com', 'Argentina'),
  ('Gabriela Moreno',  'gabriela@example.com','Uruguay'),
  ('Hernán Torres',    'hernan@example.com',  'Chile');

INSERT INTO products (name, category, price) VALUES
  ('Mechanical Keyboard', 'Peripherals', 129.90),
  ('27" Monitor',         'Displays',    319.00),
  ('USB-C Hub',           'Accessories',  59.50),
  ('Ergonomic Mouse',     'Peripherals',  49.90),
  ('Laptop Stand',        'Accessories',  39.00),
  ('Noise-Cancel Headset','Audio',       199.00),
  ('Webcam 1080p',        'Peripherals',  79.90),
  ('Desk Lamp',           'Accessories',  34.50);

INSERT INTO orders (customer_id, status, placed_at) VALUES
  (1, 'paid',      now() - interval '40 days'),
  (2, 'paid',      now() - interval '35 days'),
  (3, 'paid',      now() - interval '30 days'),
  (1, 'paid',      now() - interval '25 days'),
  (4, 'refunded',  now() - interval '20 days'),
  (5, 'paid',      now() - interval '18 days'),
  (6, 'paid',      now() - interval '12 days'),
  (7, 'paid',      now() - interval '9 days'),
  (2, 'paid',      now() - interval '6 days'),
  (8, 'paid',      now() - interval '3 days'),
  (3, 'pending',   now() - interval '1 day');

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 129.90), (1, 4, 1, 49.90),
  (2, 2, 2, 319.00),
  (3, 6, 1, 199.00), (3, 3, 1, 59.50),
  (4, 7, 1, 79.90), (4, 8, 2, 34.50),
  (5, 2, 1, 319.00),
  (6, 1, 1, 129.90), (6, 5, 1, 39.00), (6, 4, 1, 49.90),
  (7, 3, 3, 59.50),
  (8, 6, 1, 199.00), (8, 7, 1, 79.90),
  (9, 2, 1, 319.00), (9, 1, 1, 129.90),
  (10, 5, 2, 39.00), (10, 8, 1, 34.50), (10, 4, 1, 49.90),
  (11, 6, 1, 199.00);

-- Revenue by country (paid orders only).
CREATE VIEW revenue_by_country AS
SELECT
  c.country,
  count(DISTINCT o.id)              AS orders,
  sum(oi.quantity * oi.unit_price)  AS revenue
FROM customers c
JOIN orders o       ON o.customer_id = c.id AND o.status = 'paid'
JOIN order_items oi ON oi.order_id = o.id
GROUP BY c.country
ORDER BY revenue DESC;

-- Top products by units sold (paid orders only).
CREATE VIEW top_products AS
SELECT
  p.name,
  p.category,
  sum(oi.quantity)                  AS units_sold,
  sum(oi.quantity * oi.unit_price)  AS revenue
FROM products p
JOIN order_items oi ON oi.product_id = p.id
JOIN orders o       ON o.id = oi.order_id AND o.status = 'paid'
GROUP BY p.id, p.name, p.category
ORDER BY units_sold DESC;

COMMIT;
