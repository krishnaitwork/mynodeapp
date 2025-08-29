#!/usr/bin/env node

/**
 * API Test Script for App 3
 * This script demonstrates how to interact with the Swagger-documented API
 */

const https = require('https');
const http = require('http');

// Configuration
const API_HOST = 'api.local.console';
const API_PORT = 4443; // Gateway HTTPS port
const API_BASE = `https://${API_HOST}:${API_PORT}`;

// Helper function to make HTTP requests
function makeRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const response = {
            status: res.statusCode,
            headers: res.headers,
            data: body ? JSON.parse(body) : null
          };
          resolve(response);
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, data: body });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// Test functions
async function testHealthCheck() {
  console.log('\n🏥 Testing Health Check...');
  try {
    const response = await makeRequest({
      hostname: API_HOST,
      port: API_PORT,
      path: '/health',
      method: 'GET',
      rejectUnauthorized: false // For self-signed certificates
    });

    console.log(`Status: ${response.status}`);
    console.log(`Response: ${response.data}`);
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
  }
}

async function testGetUsers() {
  console.log('\n👥 Testing GET /api/users...');
  try {
    const response = await makeRequest({
      hostname: API_HOST,
      port: API_PORT,
      path: '/api/users',
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      rejectUnauthorized: false
    });

    console.log(`Status: ${response.status}`);
    console.log('Users:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('❌ Get users failed:', error.message);
  }
}

async function testCreateUser() {
  console.log('\n➕ Testing POST /api/users...');
  try {
    const newUser = {
      name: 'Test User',
      email: 'test@example.com'
    };

    const response = await makeRequest({
      hostname: API_HOST,
      port: API_PORT,
      path: '/api/users',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(newUser))
      },
      rejectUnauthorized: false
    }, newUser);

    console.log(`Status: ${response.status}`);
    console.log('Created User:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('❌ Create user failed:', error.message);
  }
}

async function testGetProducts() {
  console.log('\n📦 Testing GET /api/products...');
  try {
    const response = await makeRequest({
      hostname: API_HOST,
      port: API_PORT,
      path: '/api/products',
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      rejectUnauthorized: false
    });

    console.log(`Status: ${response.status}`);
    console.log('Products:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('❌ Get products failed:', error.message);
  }
}

async function testCreateProduct() {
  console.log('\n🛍️ Testing POST /api/products...');
  try {
    const newProduct = {
      name: 'Wireless Headphones',
      price: 149.99,
      category: 'Electronics'
    };

    const response = await makeRequest({
      hostname: API_HOST,
      port: API_PORT,
      path: '/api/products',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(newProduct))
      },
      rejectUnauthorized: false
    }, newProduct);

    console.log(`Status: ${response.status}`);
    console.log('Created Product:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('❌ Create product failed:', error.message);
  }
}

async function testAPIInfo() {
  console.log('\nℹ️ Testing GET /api...');
  try {
    const response = await makeRequest({
      hostname: API_HOST,
      port: API_PORT,
      path: '/api',
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      rejectUnauthorized: false
    });

    console.log(`Status: ${response.status}`);
    console.log('API Info:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('❌ Get API info failed:', error.message);
  }
}

// Main test runner
async function runTests() {
  console.log('🚀 Starting API Tests for App 3');
  console.log('=' .repeat(50));
  console.log(`API Base URL: ${API_BASE}`);
  console.log(`Swagger UI: ${API_BASE}/api-docs`);
  console.log('=' .repeat(50));

  // Wait a moment for the server to be ready
  console.log('⏳ Waiting for server to be ready...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    await testHealthCheck();
    await testAPIInfo();
    await testGetUsers();
    await testCreateUser();
    await testGetUsers(); // Check if user was added
    await testGetProducts();
    await testCreateProduct();
    await testGetProducts(); // Check if product was added

    console.log('\n✅ All tests completed!');
    console.log('\n📖 Visit Swagger UI at:');
    console.log(`${API_BASE}/api-docs`);
    console.log('\n🔗 API Endpoints:');
    console.log(`${API_BASE}/api/users`);
    console.log(`${API_BASE}/api/products`);

  } catch (error) {
    console.error('\n❌ Test suite failed:', error.message);
  }
}

// Run tests if this script is executed directly
if (require.main === module) {
  runTests();
}

module.exports = {
  testHealthCheck,
  testGetUsers,
  testCreateUser,
  testGetProducts,
  testCreateProduct,
  testAPIInfo,
  runTests
};
