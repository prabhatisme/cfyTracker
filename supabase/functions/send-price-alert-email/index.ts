import { corsHeaders } from '../_shared/cors.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

interface RequestBody {
  type: 'alert_setup' | 'price_triggered';
  product: any;
  alert: any;
  userEmail: string;
  newPrice?: number;
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { type, product, alert, userEmail, newPrice }: RequestBody = await req.json();

    if (!type || !product || !alert || !userEmail) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Get auth header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Authorization header required' }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get user from auth token
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid authorization token' }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Send appropriate email based on type
    if (type === 'alert_setup') {
      await sendPriceAlertSetupEmail(userEmail, product, alert);
    } else if (type === 'price_triggered') {
      await sendPriceTriggeredEmail(userEmail, product, alert, newPrice!);
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Email sent successfully' }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('Error sending email:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to send email' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

async function sendPriceAlertSetupEmail(userEmail: string, product: any, alert: any) {
  const savings = product.mrp - product.sale_price;
  
  // Get Resend API key from environment
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  
  if (!resendApiKey) {
    console.error('❌ RESEND_API_KEY not found in environment variables');
    console.log('📧 EMAIL SIMULATION - Price alert setup for:', userEmail);
    console.log('📦 Product:', product.title);
    console.log('🎯 Target Price:', `₹${alert.target_price.toLocaleString()}`);
    console.log('💰 Current Price:', `₹${product.sale_price.toLocaleString()}`);
    return;
  }

  const fromEmail = 'onboarding@resend.dev';

  const emailContent = {
    from: `PriceTracker <${fromEmail}>`,
    to: [userEmail],
    subject: `🔔 Price Alert Set: ${product.title}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f8fafc; padding: 20px;">
        <div style="background-color: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #2563eb; margin: 0; font-size: 28px; font-weight: bold;">🎯 PriceTracker</h1>
            <p style="color: #64748b; margin: 10px 0 0 0; font-size: 16px;">Your Smart Price Alert System</p>
          </div>

          <!-- Alert Confirmation -->
          <div style="background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: white; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 30px;">
            <h2 style="margin: 0 0 10px 0; font-size: 24px;">🔔 Price Alert Activated!</h2>
            <p style="margin: 0; font-size: 16px; opacity: 0.9;">We'll notify you when the price drops to your target</p>
          </div>

          <!-- Product Details -->
          <div style="background-color: #f1f5f9; padding: 25px; border-radius: 8px; margin-bottom: 25px;">
            <h3 style="color: #1e293b; margin: 0 0 15px 0; font-size: 20px; font-weight: 600;">${product.title}</h3>
            
            <div style="display: grid; gap: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Current Price:</span>
                <span style="color: #059669; font-size: 18px; font-weight: bold;">₹${product.sale_price.toLocaleString()}</span>
              </div>
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Your Target Price:</span>
                <span style="color: #8b5cf6; font-size: 18px; font-weight: bold;">₹${alert.target_price.toLocaleString()}</span>
              </div>
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Potential Savings:</span>
                <span style="color: #dc2626; font-weight: bold;">₹${(product.sale_price - alert.target_price).toLocaleString()}</span>
              </div>
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Condition:</span>
                <span style="color: #1e293b; font-weight: 500;">${product.condition}</span>
              </div>
              
              ${product.storage ? `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0;">
                <span style="color: #64748b; font-weight: 500;">Storage:</span>
                <span style="color: #1e293b; font-weight: 500;">${product.storage}</span>
              </div>
              ` : ''}
            </div>

            <div style="background-color: #ddd6fe; border: 1px solid #c4b5fd; padding: 15px; border-radius: 6px; margin-top: 15px;">
              <p style="margin: 0; color: #5b21b6; font-weight: 600; text-align: center;">
                🎯 We'll email you immediately when the price drops to ₹${alert.target_price.toLocaleString()} or below!
              </p>
            </div>
          </div>

          <!-- What Happens Next -->
          <div style="background-color: #eff6ff; border-left: 4px solid #2563eb; padding: 20px; margin-bottom: 25px;">
            <h4 style="color: #1e40af; margin: 0 0 12px 0; font-size: 18px;">📋 What happens next?</h4>
            <ul style="color: #1e40af; margin: 0; padding-left: 20px; line-height: 1.6;">
              <li>We'll monitor this product's price every hour</li>
              <li>You'll get an instant email when your target price is reached</li>
              <li>The alert will automatically deactivate after triggering</li>
              <li>You can manage your alerts anytime in your dashboard</li>
            </ul>
          </div>

          <!-- Action Buttons -->
          <div style="text-align: center; margin-bottom: 25px;">
            <a href="${product.url}" 
               style="display: inline-block; background-color: #2563eb; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 0 10px 10px 0; font-size: 16px;">
              🛒 View Product
            </a>
          </div>

          <!-- Footer -->
          <div style="border-top: 1px solid #e2e8f0; padding-top: 20px; text-align: center;">
            <p style="color: #64748b; font-size: 14px; margin: 0 0 10px 0;">
              Happy hunting! 🎯 We'll help you catch the best deals.
            </p>
            <p style="color: #94a3b8; font-size: 12px; margin: 0;">
              You received this email because you set up a price alert on PriceTracker.
            </p>
          </div>
        </div>
      </div>
    `
  };

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailContent),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Resend API error: ${response.status} - ${errorData}`);
    }

    const result = await response.json();
    console.log('✅ Price alert setup email sent successfully via Resend:', result.id);
    
  } catch (error) {
    console.error('❌ Failed to send price alert setup email via Resend:', error);
    
    // Fallback: Log detailed email information
    console.log('=== PRICE ALERT SETUP EMAIL (FALLBACK) ===');
    console.log('To:', userEmail);
    console.log('Subject:', emailContent.subject);
    console.log('Product:', product.title);
    console.log('Target Price:', `₹${alert.target_price.toLocaleString()}`);
    console.log('Current Price:', `₹${product.sale_price.toLocaleString()}`);
    console.log('==========================================');
    
    throw error;
  }
}

async function sendPriceTriggeredEmail(userEmail: string, product: any, alert: any, newPrice: number) {
  // Get Resend API key from environment
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  
  if (!resendApiKey) {
    console.error('❌ RESEND_API_KEY not found in environment variables');
    console.log('📧 EMAIL SIMULATION - Price alert triggered for:', userEmail);
    console.log('📦 Product:', product.title);
    console.log('🎯 Target Price:', `₹${alert.target_price.toLocaleString()}`);
    console.log('💰 New Price:', `₹${newPrice.toLocaleString()}`);
    return;
  }

  const fromEmail = 'onboarding@resend.dev';
  const savings = alert.target_price - newPrice;

  const emailContent = {
    from: `PriceTracker <${fromEmail}>`,
    to: [userEmail],
    subject: `🎉 Price Alert Triggered: ${product.title} - Now ₹${newPrice.toLocaleString()}!`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f8fafc; padding: 20px;">
        <div style="background-color: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #2563eb; margin: 0; font-size: 28px; font-weight: bold;">🎯 PriceTracker</h1>
            <p style="color: #64748b; margin: 10px 0 0 0; font-size: 16px;">Your Price Alert Has Been Triggered!</p>
          </div>

          <!-- Alert Triggered -->
          <div style="background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 30px;">
            <h2 style="margin: 0 0 10px 0; font-size: 24px;">🎉 Great News! Price Dropped!</h2>
            <p style="margin: 0; font-size: 16px; opacity: 0.9;">Your target price has been reached - time to buy!</p>
          </div>

          <!-- Price Comparison -->
          <div style="background-color: #f1f5f9; padding: 25px; border-radius: 8px; margin-bottom: 25px;">
            <h3 style="color: #1e293b; margin: 0 0 15px 0; font-size: 20px; font-weight: 600;">${product.title}</h3>
            
            <div style="display: grid; gap: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">New Price:</span>
                <span style="color: #059669; font-size: 24px; font-weight: bold;">₹${newPrice.toLocaleString()}</span>
              </div>
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Your Target:</span>
                <span style="color: #8b5cf6; font-size: 18px; font-weight: bold;">₹${alert.target_price.toLocaleString()}</span>
              </div>
              
              ${savings > 0 ? `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Extra Savings:</span>
                <span style="color: #dc2626; font-weight: bold;">₹${savings.toLocaleString()} below target!</span>
              </div>
              ` : ''}
              
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                <span style="color: #64748b; font-weight: 500;">Condition:</span>
                <span style="color: #1e293b; font-weight: 500;">${product.condition}</span>
              </div>
              
              ${product.storage ? `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0;">
                <span style="color: #64748b; font-weight: 500;">Storage:</span>
                <span style="color: #1e293b; font-weight: 500;">${product.storage}</span>
              </div>
              ` : ''}
            </div>

            <div style="background-color: #dcfce7; border: 1px solid #bbf7d0; padding: 15px; border-radius: 6px; margin-top: 15px;">
              <p style="margin: 0; color: #166534; font-weight: 600; text-align: center;">
                🎯 Perfect! The price has dropped ${savings > 0 ? `₹${savings.toLocaleString()} below` : 'to'} your target price!
              </p>
            </div>
          </div>

          <!-- Urgency Message -->
          <div style="background-color: #fef3c7; border: 1px solid #fbbf24; padding: 20px; border-radius: 8px; margin-bottom: 25px;">
            <h4 style="color: #92400e; margin: 0 0 12px 0; font-size: 18px;">⏰ Act Fast!</h4>
            <p style="color: #92400e; margin: 0; line-height: 1.6;">
              Great deals don't last long! This price might go back up soon. 
              Consider purchasing now to secure this amazing deal.
            </p>
          </div>

          <!-- Action Buttons -->
          <div style="text-align: center; margin-bottom: 25px;">
            <a href="${product.url}" 
               style="display: inline-block; background-color: #059669; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 18px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
              🛒 Buy Now on Cashify
            </a>
          </div>

          <!-- Alert Status -->
          <div style="background-color: #f3f4f6; border: 1px solid #d1d5db; padding: 15px; border-radius: 6px; margin-bottom: 20px;">
            <p style="margin: 0; color: #374151; text-align: center; font-weight: 500;">
              📋 This price alert has been automatically deactivated. Set up a new alert if you want to continue monitoring this product.
            </p>
          </div>

          <!-- Footer -->
          <div style="border-top: 1px solid #e2e8f0; padding-top: 20px; text-align: center;">
            <p style="color: #64748b; font-size: 14px; margin: 0 0 10px 0;">
              Happy shopping! 🛍️ Thanks for using PriceTracker.
            </p>
            <p style="color: #94a3b8; font-size: 12px; margin: 0;">
              You received this email because your price alert was triggered.
            </p>
          </div>
        </div>
      </div>
    `
  };

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailContent),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Resend API error: ${response.status} - ${errorData}`);
    }

    const result = await response.json();
    console.log('✅ Price triggered email sent successfully via Resend:', result.id);
    
  } catch (error) {
    console.error('❌ Failed to send price triggered email via Resend:', error);
    
    // Fallback: Log detailed email information
    console.log('=== PRICE TRIGGERED EMAIL (FALLBACK) ===');
    console.log('To:', userEmail);
    console.log('Subject:', emailContent.subject);
    console.log('Product:', product.title);
    console.log('Target Price:', `₹${alert.target_price.toLocaleString()}`);
    console.log('New Price:', `₹${newPrice.toLocaleString()}`);
    console.log('========================================');
    
    throw error;
  }
}